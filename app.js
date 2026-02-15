/* =========================================================================
   app.js — FIX (DB local + utilidades + cálculos + inversión/recuperación)
   ========================================================================= */

const DB_KEY = "tienda_db_v1";

const STATUS = [
  "En stock",
  "Reservado/Vendido",
  "No retirado",
  "Reenvío",
  "Retirado",
  "Depositado"
];

// ---------- Utils ----------
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

// ---------- Default DB ----------
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

// ---------- Migration ----------
function ensureSaleMeta(item) {
  if (!item.saleMeta) {
    item.saleMeta = { customerName: "", destination: "", pickupDueDate: "", courier: "" };
  } else {
    item.saleMeta.customerName = item.saleMeta.customerName || "";
    item.saleMeta.destination = item.saleMeta.destination || "";
    item.saleMeta.pickupDueDate = item.saleMeta.pickupDueDate || "";
    item.saleMeta.courier = item.saleMeta.courier || "";
  }
}

function migrateDB(db) {
  if (!db || typeof db !== "object") db = defaultDB();

  db.config = db.config || {};
  db.lots = Array.isArray(db.lots) ? db.lots : [];
  db.items = Array.isArray(db.items) ? db.items : [];
  db.expenses = Array.isArray(db.expenses) ? db.expenses : [];

  db.config.fx = (db.config.fx ?? 7.5);
  db.config.noRetFixed = (db.config.noRetFixed ?? 1.0);
  db.config.noRetCustom = (db.config.noRetCustom ?? 3.0);
  db.config.mariitaFixed = (db.config.mariitaFixed ?? 0.0);

  db.lots.forEach(l => {
    if (!l.id) l.id = uid("LOT");
    if (l.date === undefined) l.date = new Date().toISOString().slice(0, 10);
    if (l.qty === undefined) l.qty = 1;
    if (l.customsTotal === undefined) l.customsTotal = 0;
    if (l.purchaseTotalQ === undefined) l.purchaseTotalQ = 0; // NUEVO
    if (l.fx === undefined) l.fx = db.config.fx;              // NUEVO
  });

  db.items.forEach(it => {
    if (!it.id) it.id = uid("ITM");
    if (!it.status) it.status = "En stock";
    if (!it.dates) {
      it.dates = { in:"", reserved:"", noRetirado:"", reenvio:"", retirado:"", depositado:"" };
    }
    ensureSaleMeta(it); // NUEVO
    if (it.noRetType === undefined) it.noRetType = "Destino fijo";
    if (it.mariitaCost === undefined) it.mariitaCost = 0;
    if (it.salePrice === undefined) it.salePrice = 0;
    if (it.channel === undefined) it.channel = "";
  });

  db.expenses.forEach(ex => {
    if (!ex.id) ex.id = uid("EXP");
    if (!ex.date) ex.date = new Date().toISOString().slice(0, 10);
    if (ex.amount === undefined) ex.amount = 0;
    if (!ex.category) ex.category = "General";
    if (!ex.note) ex.note = "";
  });

  return db;
}

// ---------- Storage ----------
function saveDB(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function loadDB() {
  let db;
  try {
    const raw = localStorage.getItem(DB_KEY);
    db = raw ? JSON.parse(raw) : defaultDB();
  } catch (e) {
    db = defaultDB();
  }
  db = migrateDB(db);
  saveDB(db);
  return db;
}

// ---------- Costs & Profit ----------
function calcItemCosts(db, item) {
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
  const costs = calcItemCosts(db, item);

  let noRetPenalty = 0;
  if (item.status === "No retirado") {
    const type = (item.noRetType || "Destino fijo");
    noRetPenalty = type === "Personalizado" ? num(db.config.noRetCustom || 3) : num(db.config.noRetFixed || 1);
  }

  const mariita = num(item.mariitaCost || 0);
  const revenue = num(item.salePrice || 0);
  const totalCost = costs.base + mariita + noRetPenalty;

  const profit = isSaleReal(item.status) ? (revenue - totalCost) : 0;

  return { revenue, mariita, noRetPenalty, totalCost, profit };
}

// ---------- Investment & Recovery ----------
function lotInvestmentUSD(db, lot) {
  const fx = num(lot.fx || db.config.fx || 7.5);
  const purchaseUSD = num(lot.purchaseTotalQ || 0) / fx;
  const customsUSD = num(lot.customsTotal || 0);
  return purchaseUSD + customsUSD;
}

function lotRecoveryUSD(db, lotId) {
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

// ---------- Export ----------
function exportJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Expose globals for inline scripts
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

