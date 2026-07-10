// Trade journal engine: TT-screenshot fill ingestion (Claude vision), FIFO
// position matching, and per-symbol point multipliers for dollar P&L.

const VISION_MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-4-8';

// Dollars per 1.00 point of the quoted spread price, per TT symbol.
// Editable via the 'multipliers' setting on the Admin page.
const DEFAULT_MULTIPLIERS = {
  GF: 500,   // Feeder Cattle (50,000 lb, cents/lb)
  LE: 400,   // Live Cattle (40,000 lb)
  HE: 400,   // Lean Hogs (40,000 lb)
  ZC: 50,    // Corn (5,000 bu, cents/bu)
  ZS: 50,    // Soybeans
  ZW: 50,    // Chicago Wheat
  KE: 50,    // KC Wheat
  ZM: 100,   // Soybean Meal ($/ton)
  ZL: 600,   // Soybean Oil (60,000 lb, cents/lb)
  ZO: 50,    // Oats
  CL: 1000,  // Crude Oil
  NG: 10000, // Natural Gas
  GC: 100,   // Gold
  SI: 5000,  // Silver
};

const FILLS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          side: { type: 'string' },
          qty: { type: 'integer' },
          exchange: { type: 'string' },
          symbol: { type: 'string' },
          contract: { type: 'string' },
          price: { type: 'number' },
          account: { type: 'string' },
          tif: { type: 'string' },
          orderType: { type: 'string' },
        },
        required: ['side', 'qty', 'symbol', 'contract', 'price'],
      },
    },
  },
  required: ['fills'],
};

const VISION_PROMPT = `This is a screenshot of a futures trading order book / fills blotter (typically Trading Technologies). Extract every FILLED order row — rows whose Filled column shows 100(%) or whose executed quantity (ExeQty) is at least 1. Skip working, cancelled, or unfilled rows.

For each filled row report:
- side: "B" or "S" exactly as shown in the B/S column
- qty: the executed quantity (ExeQty column; not OrdQty if they differ)
- exchange: e.g. CME
- symbol: the product code, the first token of the contract description (e.g. "GF", "HE")
- contract: the rest of the contract description without the symbol (e.g. "Aug26-Oct26 Calendar", "Aug26 1mo Butterfly")
- price: the average fill price (AvgPrc column; may be negative for butterflies)
- account, tif (e.g. Day/GTC), orderType (e.g. Limit)

Report each row exactly once, top to bottom. Never invent rows or values.`;

function normalizeFill(f) {
  const sideRaw = String(f.side || '').trim().toLowerCase();
  const side = ['b', 'buy'].includes(sideRaw) ? 'buy'
    : ['s', 'sell'].includes(sideRaw) ? 'sell' : null;
  if (!side) throw new Error(`Unrecognized side "${f.side}"`);
  const qty = Number(f.qty);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Bad qty "${f.qty}"`);
  const price = Number(f.price);
  if (!Number.isFinite(price)) throw new Error(`Bad price "${f.price}"`);
  const symbol = String(f.symbol || '').trim().toUpperCase();
  if (!symbol) throw new Error('Missing symbol');
  return {
    side, qty, price, symbol,
    exchange: f.exchange ? String(f.exchange).trim().toUpperCase() : null,
    contract: String(f.contract || '').trim(),
    account: f.account ? String(f.account).trim() : null,
    tif: f.tif ? String(f.tif).trim() : null,
    orderType: f.orderType ? String(f.orderType).trim() : null,
  };
}

function spreadType(contract) {
  if (/butterfly|fly/i.test(contract)) return 'Butterfly';
  if (/calendar|spread/i.test(contract)) return 'Calendar';
  return 'Other';
}

async function defaultVision({ imageBase64, mediaType, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const resp = await client.messages.create({
    model,
    max_tokens: 3000,
    thinking: { type: 'adaptive' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: VISION_PROMPT },
      ],
    }],
    output_config: { format: { type: 'json_schema', schema: FILLS_SCHEMA }, effort: 'medium' },
  });
  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');
  return JSON.parse(textBlock.text);
}

async function parseFillsFromImage({ imageBase64, mediaType, vision }) {
  if (!vision) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Screenshot parsing needs ANTHROPIC_API_KEY (set it in Railway). You can still add trades manually below.');
    }
    vision = defaultVision;
  }
  const out = await vision({ imageBase64, mediaType, model: VISION_MODEL });
  return (out.fills || []).map(normalizeFill);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function contractKey(f) { return `${f.symbol} ${f.contract}`; }

// FIFO lot matching per contract. fills: [{id, trade_date:'YYYY-MM-DD', side,
// qty, symbol, contract, price}] in any order. Returns open positions and
// closed round trips (points always; dollars when the symbol has a multiplier).
function matchFills(fills, multipliers = DEFAULT_MULTIPLIERS) {
  const sorted = [...fills].sort((a, b) => (
    a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : (a.id || 0) - (b.id || 0)
  ));
  const groups = new Map();
  for (const f of sorted) {
    const k = contractKey(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  const open = []; const closed = [];
  for (const [key, list] of groups) {
    const queue = []; // open lots, oldest first
    for (const f of list) {
      let remaining = f.qty;
      while (remaining > 0 && queue.length && queue[0].side !== f.side) {
        const lot = queue[0];
        const m = Math.min(remaining, lot.qty);
        const points = lot.side === 'buy' ? f.price - lot.price : lot.price - f.price;
        const mult = multipliers[f.symbol];
        closed.push({
          key, symbol: f.symbol, contract: f.contract, type: spreadType(f.contract),
          side: lot.side === 'buy' ? 'long' : 'short', qty: m,
          entryDate: lot.date, exitDate: f.trade_date,
          entryPrice: lot.price, exitPrice: f.price,
          points: round4(points),
          pnl: mult != null ? round2(points * mult * m) : null,
          holdDays: daysBetween(lot.date, f.trade_date),
        });
        lot.qty -= m; remaining -= m;
        if (lot.qty === 0) queue.shift();
      }
      if (remaining > 0) queue.push({ side: f.side, qty: remaining, price: f.price, date: f.trade_date });
    }
    if (queue.length) {
      const qty = queue.reduce((s, l) => s + l.qty, 0);
      const avg = queue.reduce((s, l) => s + l.price * l.qty, 0) / qty;
      open.push({
        key, symbol: list[0].symbol, contract: list[0].contract, type: spreadType(list[0].contract),
        side: queue[0].side === 'buy' ? 'long' : 'short',
        qty, avgPrice: round4(avg), since: queue[0].date,
      });
    }
  }
  open.sort((a, b) => (a.since < b.since ? -1 : 1));
  closed.sort((a, b) => (a.exitDate < b.exitDate ? -1 : 1));
  return { open, closed };
}

module.exports = {
  normalizeFill, matchFills, spreadType, parseFillsFromImage,
  DEFAULT_MULTIPLIERS, FILLS_SCHEMA, VISION_PROMPT,
};
