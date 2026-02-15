/* =========================================================================
   app.js — Core (DB local + utilidades + cálculos + helpers de inversión)
   Funciona con: index.html, config.html, lotes.html, inventario.html,
   ventas.html, gastos.html, reportes.html
   ========================================================================= */

/* ----------------------------- Constantes ------------------------------ */
const DB_KEY = "tienda_db_v1";

const STATUS = [
  "En stock",
  "Reservado/Vendido",
  "No retirado",
  "Reenvío",
  "Retirado",
  "Depositado"
];

/* ----------------------------- Utilidades ------------------------------ */
function uid(prefix = "ID") {
  const rand = Math.random().toString(16).slice(2);
  const t = Date.now().toString(16);
  return `${prefix}_${t}_${rand}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function money(v) {
  const n = num(v);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function isSaleReal(status) {
  return status === "Retirado" || status === "Depositado";
}

/* ----------------------------- DB Local -------------------------------- */
function defaultDB() {
  return {
    config: {
      fx: 7.5,
      noRetFixed: 1.0,
      noRetCustom: 3.0,
      mariitaFixed: 0.0
    },
    lots: [],
    items: [],
    expenses: []
  };
}

function saveDB(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) {
      const db = defaultDB();
      saveDB(db);
      return db;
    }
    const db = JSON.parse(raw);
    return db;
  } catch (e) {
    const db = defaultDB();
    saveDB(db);
    return db;
  }
}

/* ---------------------- Migración / compatibilidad --------------------- */
function ensureSaleMeta(item) {
  item.saleMeta = item.saleMeta || {
    customerName: "",
    destination: "",
    pickupDueDate: "",
    courier: ""
  };
  return item;
}

function migrateDB(db) {
  db = db || {};
  db.config = db.config || {};
  db.lots = db.lots || [];
  db.items = db.items || [];
  db.expenses = db.expenses || [];

  // defaults config
  db.config.fx = (db.config.fx ?? 7.5);
  db.config.noRetFixed = (db.config.noRetFixed ?? 1.0);
  db.config.noRetCustom = (db.config.noRetCustom ?? 3.0);
  db.config.mariitaFixed = (db.config.mariitaFixed ?? 0.0);

  // lot.purchaseTotalQ nuevo (inversión en Q)
  db.lots.forEach(l => {
    if (l.purchaseTotalQ === undefined) l.purchaseTotalQ = 0;
    if (l.fx === undefined) l.fx = db.config.fx; // para consistencia
    if (l.customsTotal === undefined) l.customsTotal = 0;
    if (l.qty === undefined) l.qty = 1;
    if (!l.id) l.id = uid("LOT");
  });

  // items saleMeta nuevo
  db.items.forEach(it => {
    ensureSaleMeta(it);
    if (!it.id) it.id = uid("ITM");
    if (!it.status) it.status = "En stock";
    if (!it.dates) {
      it.dates = { in:"", reserved:"", noRetirado:"", reenvio:"", retirado:"", depositado:"" };
    }
  });

  // expenses defaults
  db.expenses.forEach(ex => {
    if (!ex.id) ex.id = uid("EXP");
    if (!ex.date) ex.date = new Date().toISOString().slice(0, 10);
    if (ex.amount === undefined) ex.amount = 0;
  });

  return db;
}

// Parche automático: cada loadDB migra y guarda
const __loadDB = loadDB;
loadDB = function () {
  const db = __loadDB();
  const m = migrateDB(db);
  saveDB(m);
  return m;
};

/* ---------------------------- Cálculos --------------------------------- */
function calcItemCosts(db, item) {
  // Costo compra en Q -> USD + aduana por pieza
  const fx = num(item.fx || db.config.fx || 7.5);
  const costUSD = num(item.costQ) / fx;

  const lot = (db.lots || []).find(l => l.id === item.lotId);
  let customsPer = 0;
  if (lot) {
    const q = Math.max(1, Math.floor(num(lot.qty) || 1));
    customsPer = num(lot.customsTotal) / q;
  }

  const base = costUSD + customsPer;

  return { fx, costUSD, customsPer, base };
}

function calcProfit(db, item) {
  // Utilidad bruta por prenda, pero solo válida cuando es venta real
  const costs = calcItemCosts(db, item);

  // Penalización No retirado (solo si el estado es No retirado)
  let noRetPenalty = 0;
  if (item.status === "No retirado") {
    const type = (item.noRetType || "Destino fijo");
    if (type === "Personalizado") noRetPenalty = num(db.config.noRetCustom || 3);
    else noRetPenalty = num(db.config.noRetFixed || 1);
  }

  // Mariita (se asigna cuando marcan Retirado)
  const mariita = num(item.mariitaCost || 0);

  const revenue = num(item.salePrice || 0);
  const totalCost = costs.base + mariita + noRetPenalty;

  // Solo mostrar profit cuando ya es real (Retirado/Depositado)
  const profit = isSaleReal(item.status) ? (revenue - totalCost) : 0;

  return {
    revenue,
    mariita,
    noRetPenalty,
    totalCost,
    profit
  };
}

/* ---------------------- Inversión / recuperación ----------------------- */
function lotInvestmentUSD(db, lot) {
  // Inversión lote = compraTotalQ (Q->USD) + aduanaTotalUSD
  const fx = num(lot.fx || db.config.fx || 7.5);
  const purchaseUSD = num(lot.purchaseTotalQ || 0) / fx;
  const customsUSD = num(lot.customsTotal || 0);
  return purchaseUSD + customsUSD;
}

function lotRecoveryUSD(db, lotId) {
  // Recuperación lote = suma de ventas reales del lote
  const sold = (db.items || []).filter(it => it.lotId === lotId && isSaleReal(it.status));
  return sold.reduce((a, it) => a + num(it.salePrice), 0);
}

function globalInvestmentUSD(db) {
  return (db.lots || []).reduce((a, l) => a + lotInvestmentUSD(db, l), 0);
}

function globalRecoveryUSD(db) {
  const sold = (db.items || []).filter(it => isSaleReal(it.status));
  return sold.reduce((a, it) => a + num(it.salePrice), 0);
}

function globalNetAfterInvestment(db) {
  return globalRecoveryUSD(db) - globalInvestmentUSD(db);
}

/* ------------------------- Export (opcional) --------------------------- */
function exportJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Exponer algunas funciones globales si las necesitas en HTML inline
window.STATUS = STATUS;
window.uid = uid;
window.num = num;
window.money = money;
window.loadDB = loadDB;
window.saveDB = saveDB;
window.isSaleReal = isSaleReal;
window.calcItemCosts = calcItemCosts;
window.calcProfit = calcProfit;

window.lotInvestmentUSD = lotInvestmentUSD;
window.lotRecoveryUSD = lotRecoveryUSD;
window.globalInvestmentUSD = globalInvestmentUSD;
window.globalRecoveryUSD = globalRecoveryUSD;
window.globalNetAfterInvestment = globalNetAfterInvestment;
window.exportJSON = exportJSON;

  if(t.length===0) t.push("✅ Todo se ve ordenado. Mantén lotes y gastos al día para una radiografía real.");

  return t;
}
