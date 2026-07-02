// build-feed.mjs — produce ops-feed-8f21.json per la Operations Dashboard.
// Due sorgenti, selezionate da env DATA_SOURCE:
//   'sheet'    (default) -> passthrough dell'endpoint Apps Script dashdata (comportamento storico)
//   'supabase' -> ricostruisce lo STESSO shape JSON dalle viste Supabase (post-cutover dal Foglio)
// Il frontend (index.html) non cambia mai: legge solo il file committato.
// Ads ibride in modalita' supabase: META/GOOGLE/GA4 arrivano dal dashdata finche' vive,
// fallback a meta_ads_daily (Supabase) / array vuoti.
import { writeFileSync } from 'node:fs';

const OUT = 'ops-feed-8f21.json';
const MODE = (process.env.DATA_SOURCE || 'sheet').toLowerCase();
const DASHDATA_URL = 'https://script.google.com/macros/s/AKfycbz191UCEsQjkoRtIVSA__LC6q2S89utKr4KGc3vws-EGn6sTisMaRdOujfAgTloyGYB/exec?action=dashdata';
const SB_URL = process.env.SUPABASE_URL || 'https://imszbjeyplaiovylhkgl.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_DP66FFObEGagJknhGOz8xw_8KO8WIgD';

const MESI = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const r1 = (x) => Math.round((Number(x) || 0) * 10) / 10;
const N = (x) => Number(x) || 0;

async function sb(path) {
  // fetch paginato PostgREST -> array completo
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Range: `${from}-${from + 999}` },
    });
    if (!r.ok) throw new Error(`Supabase ${r.status} su ${path}: ${(await r.text()).slice(0, 200)}`);
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

async function fetchDashdata() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(DASHDATA_URL, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('dashdata HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---- mapping CE: vista Supabase (costi negativi, mc1/mc2) -> shape dashdata (costi positivi) ----
function ceToMonthly(rows) {
  const byMonth = new Map(rows.map((r) => [Number(r.month), r]));
  return MESI.map((label, i) => {
    const r = byMonth.get(i + 1);
    if (!r) return { month: label, fatturatoLordo: 0, fatturatoNetto: 0, cogs: 0, packaging: 0, commissioni: 0, logistica: 0, resi: 0, margine1: 0, salari: 0, tasse: 0, logisticaFissa: 0, opex: 0, eventi: 0, marketing: 0, margine2: 0 };
    return {
      month: label,
      // identita' finanziaria del progetto: Fatturato Netto = Lordo / 1.22 (regge anche i mesi
      // manual-only del Totale, dove le colonne *_lordo per canale non sono popolate)
      fatturatoLordo: r2(N(r.omni_netto) * 1.22),
      fatturatoNetto: r2(r.omni_netto),
      cogs: r2(Math.abs(N(r.cogs))),
      packaging: r2(Math.abs(N(r.packaging))),
      commissioni: r2(Math.abs(N(r.commissioni))),
      logistica: r2(Math.abs(N(r.logistica_var))),
      resi: r2(Math.abs(N(r.resi))),
      margine1: r2(r.mc1),
      salari: r2(Math.abs(N(r.salari))),
      tasse: r2(Math.abs(N(r.tasse))),
      logisticaFissa: r2(Math.abs(N(r.logistica_mag))),
      opex: r2(Math.abs(N(r.opex))),
      eventi: r2(Math.abs(N(r.eventi))),
      marketing: r2(Math.abs(N(r.marketing))),
      margine2: r2(r.mc2),
    };
  });
}

const varCosts = (ce) => ce.map((m) => ({ month: m.month, cogs: m.cogs, packaging: m.packaging, commissioni: m.commissioni, logistica: m.logistica, resi: m.resi }));

async function buildFromSupabase() {
  const YEAR = 2026;
  const [ceA, ceT, inv, prods, orders, lineItems, purch, exps, gifts] = await Promise.all([
    sb(`v_ce_amimi_summary?year=eq.${YEAR}&order=month&select=*`),
    sb(`v_ce_totale?year=eq.${YEAR}&order=month&select=*`),
    sb('v_inventory?select=codice,item,variant,categoria,retail_price,cogs,qty_purchased,shopify_sold,qromo_sold,gift_sold,giacenza_attuale'),
    sb('products?select=codice,item,variant,shopify_name,retail_price,cogs'),
    sb(`shopify_orders?year=eq.${YEAR}&select=order_id,order_number,month,gross_total,discount_total,shipping_total,free_shipping_amt,created_at_shop,fulfilled_at,discount_codes`),
    sb(`shopify_line_items?year=eq.${YEAR}&select=order_id,codice,month,quantita,price`),
    sb('purchases?select=data,fornitore,item,variant,quantita,costo_unitario,costo_totale,tipologia&order=data'),
    sb('expenses?select=categoria,costo'),
    sb('gifts_offline?select=data,codice,quantita,prezzo,kind&order=data'),
  ]);

  const ceAmimiMonthly = ceToMonthly(ceA);
  const ceTotaleMonthly = ceToMonthly(ceT);

  // ---- revenueData: canali da vista CE + aggregati ordini Shopify; gift = Totale - Amimi (come backend) ----
  const ceAByM = new Map(ceA.map((r) => [Number(r.month), r]));
  const ceTByM = new Map(ceT.map((r) => [Number(r.month), r]));
  const ordAgg = new Map(); // month -> {orders, sconti, freeship, sped}
  for (const o of orders) {
    const m = Number(o.month);
    const a = ordAgg.get(m) || { orders: 0, sconti: 0, freeship: 0, sped: 0 };
    a.orders += 1; a.sconti += N(o.discount_total); a.freeship += N(o.free_shipping_amt); a.sped += N(o.shipping_total);
    ordAgg.set(m, a);
  }
  // Vendite lorde prodotto (pre-sconto) = somma prezzo x qta delle righe ordine
  const venditeByM = new Map();
  for (const li of lineItems) {
    const m = Number(li.month);
    venditeByM.set(m, (venditeByM.get(m) || 0) + N(li.price) * N(li.quantita));
  }
  // Gift diretti da gifts_offline (il CE-diff del backend perde i pezzi nei mesi manual-only)
  const giftByM = new Map();
  for (const g of gifts) {
    const m = Number(String(g.data || '').slice(5, 7));
    if (!m) continue;
    const a = giftByM.get(m) || { pezzi: 0, lordo: 0 };
    a.pezzi += Math.round(N(g.quantita)); a.lordo += N(g.prezzo) * N(g.quantita);
    giftByM.set(m, a);
  }
  const revenueData = MESI.map((label, i) => {
    const m = i + 1;
    const rA = ceAByM.get(m), rT = ceTByM.get(m);
    const a = ordAgg.get(m) || { orders: 0, sconti: 0, freeship: 0, sped: 0 };
    const g = giftByM.get(m) || { pezzi: 0, lordo: 0 };
    // canale "gift" = CE Totale - CE Amimi (come il backend storico: include il blocco
    // non-Amimi di gen/feb, che nella replica esiste solo come netto aggregato)
    const giftNetto = Math.max(N(rT?.omni_netto) - N(rA?.omni_netto), 0);
    const totPezzi = rT ? Math.round(N(rT.online_pezzi) + N(rT.offline_pezzi) + N(rT.b2b_pezzi)) : 0;
    const pezziCeDiff = Math.max(totPezzi - Math.round(N(rA?.online_pezzi)) - Math.round(N(rA?.offline_pezzi)), 0);
    return {
      month: label,
      shopifyOrders: a.orders,
      shopifyPezzi: Math.round(N(rA?.online_pezzi)),
      shopifyVendite: r2(venditeByM.get(m)),
      shopifyLordo: r2(rA?.online_lordo), shopifyNetto: r2(rA?.online_netto),
      shopifySconti: r2(Math.abs(a.sconti)),
      shopifyFreeShip: r2(Math.abs(a.freeship)),
      shopifySpedizioni: r2(Math.abs(a.sped)),
      qromoLordo: r2(rA?.offline_lordo), qromoNetto: r2(rA?.offline_netto),
      qromoPezzi: Math.round(N(rA?.offline_pezzi)),
      giftLordo: r2(giftNetto * 1.22),
      giftNetto: r2(giftNetto),
      giftPezzi: Math.max(g.pezzi, pezziCeDiff),
    };
  });

  // ---- products / INV_FULL (semantica INVENTARIO: venduto = shopify+qromo+gift, no B2B) ----
  const invRows = inv.filter((r) => N(r.qty_purchased) > 0);
  const products = invRows.map((r) => {
    const name = `${r.item || ''} ${r.variant || ''}`.trim() || String(r.codice || '').replace(/_/g, ' ');
    const price = r2(r.retail_price), cogsUnit = r2(Math.abs(N(r.cogs)));
    const stock = Math.round(N(r.giacenza_attuale));
    const sold = Math.round(N(r.shopify_sold) + N(r.qromo_sold) + N(r.gift_sold));
    return {
      name, codice: r.codice || '', item: r.item || '', variante: r.variant || '',
      price, cogsUnit, stock, sold,
      revenue: r2(sold * price), cogs: r2(sold * cogsUnit),
      sellThrough: r2(sold + stock > 0 ? (sold / (sold + stock)) * 100 : 0),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const invFull = invRows.map((r) => {
    const name = `${r.item || ''} ${r.variant || ''}`.trim() || String(r.codice || '').replace(/_/g, ' ');
    const giacenza = Math.round(N(r.giacenza_attuale));
    const venduto = Math.round(N(r.shopify_sold) + N(r.qromo_sold) + N(r.gift_sold));
    return { name, codice: r.codice || '', giacenza, venduto, totaleProdotto: giacenza + venduto, prezzo: r2(r.retail_price), costo: r2(Math.abs(N(r.cogs))), item: r.item || '' };
  });

  // ---- inventoryByCategory (stesse 4 famiglie fisse del backend) ----
  const catMap = { 'lea bag': 'Lea Bag', 'valentina bag': 'Valentina Bag', 'maria bag': 'Maria Bag', 'nina bag': 'Nina Bag' };
  const cats = Object.fromEntries(Object.values(catMap).map((c) => [c, { category: c, count: 0, totalValue: 0 }]));
  for (const p of products) {
    const nl = p.name.toLowerCase();
    for (const [key, label] of Object.entries(catMap)) {
      if (nl.includes(key)) { cats[label].count += p.stock; cats[label].totalValue += p.stock * p.price; break; }
    }
  }
  const inventoryByCategory = Object.values(cats).map((c) => ({ ...c, totalValue: r2(c.totalValue) }));

  // ---- distribuzione valore ordini + uso sconti ----
  const distribution = { '0-50': 0, '50-100': 0, '100-150': 0, '150-200': 0, '200+': 0 };
  let withDiscount = 0, withoutDiscount = 0;
  for (const o of orders) {
    const t = N(o.gross_total);
    if (t <= 50) distribution['0-50']++; else if (t <= 100) distribution['50-100']++;
    else if (t <= 150) distribution['100-150']++; else if (t <= 200) distribution['150-200']++;
    else distribution['200+']++;
    // codice sconto se noto (da mag 2026), altrimenti importo sconto > 0
    if (o.discount_codes || N(o.discount_total) > 0) withDiscount++; else withoutDiscount++;
  }
  const orderValueDist = Object.entries(distribution).map(([range, count]) => ({ range: range + '€', count }));
  const discountUsage = [{ name: 'Con Sconto', value: withDiscount }, { name: 'Senza Sconto', value: withoutDiscount }];

  // ---- DISC_CODES (solo ordini con codice noto: da mag 2026 + tutti i futuri) ----
  const codeMap = {};
  for (const o of orders) {
    if (!o.discount_codes) continue;
    const c = (codeMap[o.discount_codes] ||= { code: o.discount_codes, orders: 0, revenue: 0, discountAmt: 0 });
    c.orders += 1; c.revenue += N(o.gross_total); c.discountAmt += Math.abs(N(o.discount_total));
  }
  const discCodes = Object.values(codeMap).map((c) => ({ ...c, revenue: r2(c.revenue), discountAmt: r2(c.discountAmt) }));

  // ---- FULFILL (ore evasione; fulfilled_at disponibile da mag 2026 in poi) ----
  const fulfill = orders.map((o) => {
    let hours = null;
    if (o.created_at_shop && o.fulfilled_at) {
      const h = (new Date(o.fulfilled_at) - new Date(o.created_at_shop)) / 3600000;
      if (!Number.isNaN(h) && h >= 0) hours = r2(h);
    }
    return { order: '#' + (o.order_number || ''), hours };
  });

  // ---- expensesByCategory ----
  const expensesByCategory = {};
  for (const e of exps) {
    const k = e.categoria || 'Unknown';
    expensesByCategory[k] = (expensesByCategory[k] || 0) + Math.abs(N(e.costo));
  }
  for (const k in expensesByCategory) expensesByCategory[k] = r2(expensesByCategory[k]);

  // ---- ACQUISTI + FORNITORI ----
  const ddmmyyyy = (iso) => {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  };
  const acquisti = purch.map((p) => {
    const qty = Math.round(N(p.quantita));
    const costoTot = r2(p.costo_totale);
    return {
      date: ddmmyyyy(p.data), fornitore: p.fornitore || '', item: p.item || '', variant: p.variant || '',
      qty, costoUnit: p.costo_unitario != null ? r2(p.costo_unitario) : (qty > 0 ? r2(costoTot / qty) : 0), costoTot,
      tipologia: p.tipologia || '',
    };
  });
  const fornMap = {};
  for (const p of purch) {
    const f = (fornMap[p.fornitore || 'Unknown'] ||= { name: p.fornitore || 'Unknown', totalSpent: 0, totalItems: 0, bags: 0, rawMaterialSpent: 0, uniq: new Set() });
    const qty = Math.round(N(p.quantita));
    f.totalItems += qty;
    if (String(p.tipologia || '').trim().toLowerCase() === 'prodotto finito') { f.totalSpent += N(p.costo_totale); f.bags += qty; }
    else f.rawMaterialSpent += N(p.costo_totale);
    if (p.item) f.uniq.add(p.item);
  }
  const fornitori = Object.values(fornMap).map((f) => ({ name: f.name, totalSpent: r2(f.totalSpent), totalItems: f.totalItems, bags: f.bags, rawMaterialSpent: r2(f.rawMaterialSpent), uniqueProducts: f.uniq.size }));

  // ---- OFFLINE_SALES (non usato dal frontend, mantenuto per compatibilita' shape) ----
  const offlineSales = gifts.map((g) => ({ date: String(g.data || '').slice(0, 10), prodotto: g.codice || '', pezzi: Math.round(N(g.quantita)), lordo: r2(N(g.prezzo) * N(g.quantita)), canale: g.kind || '' }));

  // ---- PRODUCT_MARGINALITY: i 4 campi che il frontend usa (mdcRetailPct, markupConIva, discountRate, discountShare) ----
  const orderByIdDisc = new Map(orders.map((o) => [o.order_id, { disc: !!(o.discount_codes || N(o.discount_total) > 0), rate: (N(o.gross_total) + N(o.discount_total)) > 0 ? N(o.discount_total) / (N(o.gross_total) + N(o.discount_total)) * 100 : 0 }]));
  const perCodOrders = new Map(); // codice -> Set(order_id)
  for (const li of lineItems) {
    if (!li.codice) continue;
    (perCodOrders.get(li.codice) || perCodOrders.set(li.codice, new Set()).get(li.codice)).add(li.order_id);
  }
  const productMarginality = prods.filter((p) => N(p.retail_price) > 0).map((p) => {
    const price = N(p.retail_price), cogs = Math.abs(N(p.cogs));
    const netto = price / 1.22;
    const ids = perCodOrders.get(p.codice);
    let discountRate = 0, discountShare = 0;
    if (ids && ids.size) {
      let nDisc = 0, sumRate = 0;
      for (const id of ids) {
        const od = orderByIdDisc.get(id);
        if (od?.disc) { nDisc++; sumRate += od.rate; }
      }
      discountShare = r2((nDisc / ids.size) * 100);
      discountRate = nDisc ? r2(sumRate / nDisc) : 0;
    }
    return {
      codice: p.codice, item: p.item || '', variant: p.variant || '',
      name: p.shopify_name || `${p.item || ''} ${p.variant || ''}`.trim() || String(p.codice).replace(/_/g, ' '),
      sellingPrice: r2(price), cogs: r2(cogs),
      mdcRetailPct: r2(netto > 0 ? ((netto - cogs) / netto) * 100 : 0),
      markupConIva: cogs > 0 ? r2(price / cogs) : 0, // markup effettivo (il Foglio aveva il target di listino)
      discountRate, discountShare,
    };
  });

  // ---- MARKUP (non usato dal frontend) ----
  const markup = prods.filter((p) => Math.abs(N(p.cogs)) > 0 && N(p.retail_price) > 0).map((p) => ({ name: p.codice, markup: r1(N(p.retail_price) / Math.abs(N(p.cogs))) }));

  // ---- Ads: ibrido dashdata -> fallback Supabase/vuoto ----
  let metaAds = [], googleAds = [], ga4Daily = [];
  try {
    const dd = await fetchDashdata();
    metaAds = dd.META_ADS || []; googleAds = dd.GOOGLE_ADS || []; ga4Daily = dd.GA4_DAILY || [];
    console.log('ads: da dashdata (meta=' + metaAds.length + ')');
  } catch (e) {
    console.log('ads: dashdata non raggiungibile (' + e.message + '), fallback meta_ads_daily');
    const meta = await sb('meta_ads_daily?select=*&order=date');
    metaAds = meta.map((r) => ({
      date: String(r.date).slice(0, 10), month: MESI[Number(String(r.date).slice(5, 7)) - 1] || '',
      campaign_id: r.campaign_id, campaign_name: r.campaign_name, campaign_status: r.campaign_status,
      campaign_objective: r.campaign_objective, spend: N(r.spend), impressions: N(r.impressions), reach: N(r.reach),
      frequency: N(r.frequency), clicks: N(r.clicks), link_clicks: N(r.link_clicks), ctr: N(r.ctr), cpc: N(r.cpc),
      cpm: N(r.cpm), landing_page_views: N(r.landing_page_views), view_content: N(r.view_content),
      add_to_cart: N(r.add_to_cart), initiate_checkout: N(r.initiate_checkout), add_payment_info: N(r.add_payment_info),
      purchases: N(r.purchases), purchase_value: N(r.purchase_value), cpa: N(r.cpa), roas: N(r.roas), pulled_at: r.pulled_at || '',
    }));
  }

  return {
    DATA: {
      ceAmimiMonthly, ceTotaleMonthly, revenueData,
      varCostsAmimi: varCosts(ceAmimiMonthly), varCostsTotale: varCosts(ceTotaleMonthly),
      products, inventoryByCategory, orderValueDist, discountUsage, expensesByCategory,
    },
    SHOP_STOCK: [], INV_FULL: invFull, MARKUP: markup,
    GA4_DAILY: ga4Daily, GOOGLE_ADS: googleAds, META_ADS: metaAds,
    FULFILL: fulfill, DISC_CODES: discCodes, MATERIALS: [],
    FORNITORI: fornitori, ACQUISTI: acquisti, OFFLINE_SALES: offlineSales,
    PRODUCT_MARGINALITY: productMarginality,
    lastUpdated: new Date().toISOString(),
    dataSource: 'supabase',
  };
}

// ---- main ----
const feed = MODE === 'supabase' ? await buildFromSupabase() : await fetchDashdata();
if (!feed.DATA || !Array.isArray(feed.DATA.ceAmimiMonthly) || !Array.isArray(feed.DATA.products)) {
  console.error('payload invalido (mancano DATA.ceAmimiMonthly/products)');
  process.exit(1);
}
writeFileSync(OUT, JSON.stringify(feed));
console.log(`ok [${MODE}]: mesi=${feed.DATA.ceAmimiMonthly.length} prodotti=${feed.DATA.products.length} ordiniFulfill=${(feed.FULFILL || []).length}`);
