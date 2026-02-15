const DB_KEY = "tienda_ropa_v1";

const STATUS = ["En stock","Reservado/Vendido","No retirado","Reenvío","Retirado","Depositado"];

const defaultState = () => ({
  config: {
    fx: 7.50,
    noRetFixed: 1.00,
    noRetCustom: 3.00,
    depositDays: ["Miércoles","Sábado"],
    mariitaFixed: 0.00 // costo fijo por ayuda (editable luego)
  },
  lots: [],      // {id,date,qty,customsTotal,fx,notes}
  items: [],     // prendas (ver inventario)
  expenses: [],  // gastos generales
});

function loadDB(){
  try{
    const raw = localStorage.getItem(DB_KEY);
    return raw ? JSON.parse(raw) : defaultState();
  }catch(e){
    return defaultState();
  }
}
function saveDB(db){ localStorage.setItem(DB_KEY, JSON.stringify(db)); }

function uid(prefix="ID"){
  return prefix + "_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}
function num(x){ return Number(x || 0); }
function money(n){ return num(n).toLocaleString("en-US",{style:"currency",currency:"USD"}); }

function calcItemCosts(db, item){
  // item: {costQ, fx, lotId, salePrice, ...}
  const fx = num(item.fx || db.config.fx || 7.5);
  const costUSD = num(item.costQ) / fx;

  let customsPer = 0;
  if(item.lotId){
    const lot = db.lots.find(l=>l.id===item.lotId);
    if(lot){
      customsPer = num(lot.customsTotal) / Math.max(1, Math.floor(num(lot.qty) || 1));
    }
  }
  const base = costUSD + customsPer;
  return { fx, costUSD, customsPer, base };
}

function isSaleReal(status){ return status==="Retirado" || status==="Depositado"; }

function calcProfit(db, item){
  // Mariita costo fijo se aplica cuando está Retirado/Depositado (venta real)
  const { base } = calcItemCosts(db, item);
  const mariita = isSaleReal(item.status) ? num(item.mariitaCost || db.config.mariitaFixed || 0) : 0;

  // Penalización por no-retirado
  let noRetPenalty = 0;
  if(item.status==="No retirado"){
    noRetPenalty = item.noRetType==="Personalizado" ? num(db.config.noRetCustom) : num(db.config.noRetFixed);
  }

  const totalCost = base + mariita + noRetPenalty;
  const revenue = isSaleReal(item.status) ? num(item.salePrice) : 0;
  const profit = revenue - totalCost;

  return { revenue, totalCost, profit, base, mariita, noRetPenalty };
}

function kpis(db){
  const stock = db.items.filter(x=>x.status==="En stock").length;
  const reserved = db.items.filter(x=>x.status==="Reservado/Vendido").length;
  const noRet = db.items.filter(x=>x.status==="No retirado").length;

  const sales = db.items.filter(x=>isSaleReal(x.status));
  const revenue = sales.reduce((a,x)=>a+calcProfit(db,x).revenue,0);
  const profit = sales.reduce((a,x)=>a+calcProfit(db,x).profit,0);

  return { stock, reserved, noRet, revenue, profit };
}

function tips(db){
  const t = [];
  const k = kpis(db);

  if(k.noRet >= 5) t.push("⚠️ Hay varios 'No retirado'. Considera confirmar antes de enviar o filtrar clientes por canal.");
  if(k.stock >= 30) t.push("📣 Stock alto: crea promoción por categoría (2x1 parcial / descuento por transferencia / combo gorra+camisa).");
  if(k.reserved > 0) t.push("🧾 Recordatorio: 'Reservado/Vendido' NO cuenta como dinero. Solo 'Retirado' entra como venta real.");

  if(t.length===0) t.push("✅ Todo se ve ordenado. Mantén lotes y gastos al día para una radiografía real.");

  return t;
}
