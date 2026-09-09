/* PAPER — paper trading. Pure math up top (node-testable), DOM below. */
"use strict";

/* ---------------- pure math (no DOM) ---------------- */

function calcPnl(side, qty, entry, exit) {
  // Long/Call profit when price rises; Short/Put profit when it falls.
  var s = String(side).toLowerCase();
  if (s === "long" || s === "call") return (exit - entry) * qty;
  if (s === "short" || s === "put") return (entry - exit) * qty;
  throw new Error("bad side: " + side);
}

function predPnl(side, shares, buyPrice, resolvePrice) {
  // Yes/No shares priced 0..100, resolve at 0 or 100.
  var s = String(side).toLowerCase();
  if (buyPrice < 0 || buyPrice > 100) throw new Error("price must be 0-100");
  if (resolvePrice !== 0 && resolvePrice !== 100) throw new Error("resolve must be 0 or 100");
  if (s === "yes") return (resolvePrice - buyPrice) * shares;
  if (s === "no") return (buyPrice - resolvePrice) * shares;
  throw new Error("bad side: " + side);
}

function unrealized(pos, mark) {
  if (pos.market === "prediction") return 0; // marked at cost until resolved
  return calcPnl(pos.side, pos.qty, pos.entry, mark);
}

function accountStats(acct, marks) {
  var unreal = 0, i, pos;
  for (i = 0; i < acct.positions.length; i++) {
    pos = acct.positions[i];
    var m = (marks && marks[pos.symbol]) || pos.entry;
    unreal += unrealized(pos, m);
  }
  var realized = 0, wins = 0;
  for (i = 0; i < acct.history.length; i++) {
    realized += acct.history[i].pnl;
    if (acct.history[i].pnl > 0) wins++;
  }
  return {
    cash: acct.cash,
    unrealized: unreal,
    realized: realized,
    equity: acct.cash + unreal,
    wins: wins,
    trades: acct.history.length,
    winRate: acct.history.length ? wins / acct.history.length : null
  };
}

function fmt(n) {
  var neg = n < 0;
  var s = Math.abs(n).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
  return (neg ? "-$" : "$") + s;
}
function fmtSign(n) {
  if (n > 0) return "+" + fmt(n);
  return fmt(n);
}

/* ---------------- config ---------------- */

var MARKETS = {
  crypto:     { name: "Crypto",      sides: ["Long", "Short"], priceLabel: "Entry price (USD)", live: true,
                chips: ["BTC", "ETH", "SOL", "DOGE", "XRP"],
                hint: "Live prices via CoinGecko — tap the bolt to fill. Anything else, type it manually." },
  stocks:     { name: "Stocks",      sides: ["Long", "Short"], priceLabel: "Entry price (USD)", live: false, keyLive: true,
                chips: ["NVDA", "TSLA", "AAPL", "SPY", "MSFT", "AMD"],
                hint: "Live stock quotes need your free Finnhub key — set it in Rules → Data Feeds. Until then, manual quotes. Honest > fancy." },
  options:    { name: "Options",     sides: ["Call", "Put"],   priceLabel: "Premium per contract (USD)", live: false,
                chips: ["NVDA", "TSLA", "AAPL", "SPY", "MSFT", "AMD"],
                hint: "Paper simplification: calls act like longs, puts like shorts. Contracts × premium. No free options-chain API exists without a key — premium entry stays manual." },
  futures:    { name: "Futures",     sides: ["Long", "Short"],  priceLabel: "Entry price", live: false,
                chips: ["ES", "NQ", "BTC", "ETH"],
                hint: "Manual quotes — no reliable free futures feed. Qty = contracts, 1× — size it like the real thing." },
  prediction: { name: "Prediction",  sides: ["Yes", "No"],     priceLabel: "Price (0–100¢)", live: false,
                chips: null,
                hint: "Yes/No shares priced 0–100¢. Close by resolving: event happened → 100, didn't → 0." }
};
var MARKET_KEYS = Object.keys(MARKETS);

var COINGECKO_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", DOGE: "dogecoin",
  XRP: "ripple", ADA: "cardano", AVAX: "avalanche-2", LINK: "chainlink",
  DOT: "polkadot", LTC: "litecoin", BCH: "bitcoin-cash", XLM: "stellar",
  UNI: "uniswap", ATOM: "cosmos", NEAR: "near", ARB: "arbitrum",
  OP: "optimism", INJ: "injective-protocol", SUI: "sui", PEPE: "pepe"
};

var DEFAULT_RULES = [
  "Paper only — no real money until 60 days green.",
  "Risk max 2% of the account on any single trade.",
  "No revenge trading after a loss. Walk away instead.",
  "Log the trade BEFORE you take it, not after.",
  "Options: defined risk only. No naked shorts, ever."
];

/* ---------------- state ---------------- */

var LS_KEY = "paper-trading-v1";
var state = null;
var activeTab = "crypto";
var liveMarks = {};   // "market:SYMBOL" -> {price, ts, feed}
var liveErr = "";     // crypto feed error note
var stockErr = "";    // stock feed error note
var lastCryptoTs = 0, lastStockTs = 0;

function defaultState() {
  var accounts = {};
  MARKET_KEYS.forEach(function (k) {
    accounts[k] = { start: 10000, cash: 10000, positions: [], history: [] };
  });
  return { accounts: accounts, rules: DEFAULT_RULES.map(function (t) { return { text: t, done: false }; }),
           keys: { finnhub: "", twelve: "" } };
}
function load() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) {
      state = JSON.parse(raw);
      if (!state.keys) state.keys = { finnhub: "", twelve: "" }; // migrate old saves
      return;
    }
  } catch (e) {}
  state = defaultState();
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ---------------- quote providers (pure, node-testable) ----------------
   Stooq's free quote endpoint died in 2026 (404s every symbol), so there is
   no reliable keyless stock feed left. Stocks go live via the user's own
   free-tier API key — Finnhub first (60 req/min), Twelve Data as backup. */

function finnhubQuoteUrl(sym, key) {
  return "https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(sym) + "&token=" + encodeURIComponent(key);
}
function parseFinnhubQuote(j) {
  // {"c":182.9,"d":1.2,"dp":0.66,"h":183.5,"l":181.1,"o":182.0,"pc":181.7,"t":...}
  return (j && typeof j.c === "number" && j.c > 0) ? j.c : null;
}
function twelveQuoteUrl(sym, key) {
  return "https://api.twelvedata.com/price?symbol=" + encodeURIComponent(sym) + "&apikey=" + encodeURIComponent(key);
}
function parseTwelveQuote(j) {
  // {"price":"182.90"}
  var p = j ? parseFloat(j.price) : NaN;
  return (p > 0) ? p : null;
}
function stockProvider(keys) {
  // 'finnhub' | 'twelve' | null — Finnhub preferred when both keys exist.
  if (keys && keys.finnhub) return "finnhub";
  if (keys && keys.twelve) return "twelve";
  return null;
}

/* ---------------- live crypto prices ---------------- */

function cgId(sym) {
  var s = String(sym).trim().toUpperCase();
  return COINGECKO_IDS[s] || null;
}
function fetchMarks(symbols, cb) {
  var ids = [];
  symbols.forEach(function (s) { var id = cgId(s); if (id && ids.indexOf(id) === -1) ids.push(id); });
  if (!ids.length) { if (cb) cb(); return; }
  var now = Date.now();
  var fresh = ids.filter(function (id) {
    var k = "crypto:" + id;
    return !(liveMarks[k] && now - liveMarks[k].ts < 60000);
  });
  if (!fresh.length) { if (cb) cb(); return; }
  fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + fresh.join(",") + "&vs_currencies=usd")
    .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
    .then(function (j) {
      fresh.forEach(function (id) {
        if (j[id] && typeof j[id].usd === "number") liveMarks["crypto:" + id] = { price: j[id].usd, ts: now, feed: "coingecko" };
      });
      liveErr = "";
      lastCryptoTs = now;
      if (cb) cb();
    })
    .catch(function () { liveErr = "live prices unavailable — manual entry it is"; if (cb) cb(); });
}

function fetchStockMarks(symbols, cb) {
  var prov = stockProvider(state.keys || {});
  if (!prov || !symbols.length) { if (cb) cb(); return; }
  var now = Date.now();
  var fresh = symbols.filter(function (s) {
    var k = "stocks:" + s;
    return !(liveMarks[k] && now - liveMarks[k].ts < 60000);
  });
  if (prov === "twelve") fresh = fresh.slice(0, 8); // Twelve free tier: 8 req/min
  if (!fresh.length) { if (cb) cb(); return; }
  var key = prov === "finnhub" ? state.keys.finnhub : state.keys.twelve;
  var jobs = fresh.map(function (s) {
    var url = prov === "finnhub" ? finnhubQuoteUrl(s, key) : twelveQuoteUrl(s, key);
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) {
        var p = prov === "finnhub" ? parseFinnhubQuote(j) : parseTwelveQuote(j);
        if (p !== null) liveMarks["stocks:" + s] = { price: p, ts: now, feed: prov };
      })
      .catch(function () {});
  });
  Promise.all(jobs).then(function () {
    stockErr = "";
    lastStockTs = now;
    if (cb) cb();
  }).catch(function () {
    stockErr = "stock quotes unavailable — check your key or enter manually";
    if (cb) cb();
  });
}

function markFor(pos) {
  var k = pos.market + ":" + pos.symbol;
  if ((pos.market === "crypto" || pos.market === "stocks") && liveMarks[k]) return liveMarks[k].price;
  return pos.entry;
}
function lastQuote(sym, market) {
  // Last known quote for a symbol, or null. Sync — trains read the cache.
  // market optional: "crypto" | "stocks" | "futures" — checked in that order when omitted.
  var s = String(sym).trim().toUpperCase();
  var order = market ? [market] : ["crypto", "stocks", "futures"];
  for (var i = 0; i < order.length; i++) {
    var m = liveMarks[order[i] + ":" + s];
    if (m && typeof m.price === "number") return { price: m.price, ts: m.ts, feed: m.feed };
  }
  return null;
}

/* ---------------- actions ---------------- */

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function placePosition(market, sym, side, qty, entry) {
  // Core trade open. Throws on bad input; the DOM form and the Paper API both go through here.
  if (!MARKETS[market]) throw new Error("unknown account: " + market);
  sym = String(sym == null ? "" : sym).trim().toUpperCase();
  if (!sym) throw new Error("Enter a symbol.");
  if (!(qty > 0)) throw new Error("Quantity must be above 0.");
  if (!(entry >= 0)) throw new Error("Enter a valid price.");
  if (market === "prediction" && (entry < 0 || entry > 100)) throw new Error("Prediction price must be 0–100¢.");
  var pos = { id: uid(), market: market, symbol: sym, side: side, qty: qty, entry: entry, ts: Date.now() };
  state.accounts[market].positions.push(pos);
  save();
  return pos;
}

function openPosition(market) {
  try {
    placePosition(market,
      document.getElementById("f-sym").value,
      document.getElementById("f-side").value,
      parseFloat(document.getElementById("f-qty").value),
      parseFloat(document.getElementById("f-entry").value));
  } catch (e) { alert(e.message); return; }
  render();
}

function closePositionCore(market, id, exit) {
  // Core trade close. Throws on bad input; the DOM form and the Paper API both go through here.
  // Returns the history record. Prediction markets close by resolving: exit 0 or 100 only.
  if (!MARKETS[market]) throw new Error("unknown account: " + market);
  var acct = state.accounts[market];
  var i, pos = null;
  for (i = 0; i < acct.positions.length; i++) if (acct.positions[i].id === id) pos = acct.positions[i];
  if (!pos) throw new Error("position not found: " + id);
  if (market === "prediction") {
    if (exit !== 0 && exit !== 100) throw new Error("Prediction close: exit must be 0 (NO happened) or 100 (YES happened).");
    return resolvePosition(market, id, exit === 100 ? "yes" : "no");
  }
  if (!(exit >= 0)) throw new Error("Enter a valid exit price.");
  var pnl = calcPnl(pos.side, pos.qty, pos.entry, exit);
  acct.cash += pnl;
  var rec = { id: uid(), symbol: pos.symbol, side: pos.side, qty: pos.qty, entry: pos.entry, exit: exit, pnl: pnl, ts: Date.now() };
  acct.history.unshift(rec);
  acct.positions = acct.positions.filter(function (p) { return p.id !== id; });
  save();
  return rec;
}

function closePosition(market, id) {
  try {
    closePositionCore(market, id, parseFloat(document.getElementById("x-" + id).value));
  } catch (e) { alert(e.message); return; }
  render();
}

function resolvePosition(market, id, outcome) {
  // outcome: "yes" -> 100, "no" -> 0
  var acct = state.accounts[market];
  var pos = null, i;
  for (i = 0; i < acct.positions.length; i++) if (acct.positions[i].id === id) pos = acct.positions[i];
  if (!pos) return;
  var resolvePrice = outcome === "yes" ? 100 : 0;
  var pnl = predPnl(pos.side, pos.qty, pos.entry, resolvePrice);
  acct.cash += pnl;
  var rec = { id: uid(), symbol: pos.symbol, side: pos.side, qty: pos.qty, entry: pos.entry,
    exit: resolvePrice, exitLabel: outcome === "yes" ? "Resolved YES" : "Resolved NO", pnl: pnl, ts: Date.now() };
  acct.history.unshift(rec);
  acct.positions = acct.positions.filter(function (p) { return p.id !== id; });
  save();
  return rec;
}

function resetAccount(market) {
  var acct = state.accounts[market];
  if (!confirm("Reset " + MARKETS[market].name + "? Clears positions and history, restores $" + acct.start.toLocaleString() + ".")) return;
  state.accounts[market] = { start: acct.start, cash: acct.start, positions: [], history: [] };
  save(); render();
}

function setStart(market) {
  var v = parseFloat(document.getElementById("start-" + market).value);
  if (!(v > 0)) return alert("Starting balance must be above 0.");
  var acct = state.accounts[market];
  var diff = v - acct.start;
  acct.start = v; acct.cash += diff;
  save(); render();
}

function saveKeys() {
  var f = document.getElementById("key-finnhub"), t = document.getElementById("key-twelve");
  state.keys = {
    finnhub: f ? f.value.trim() : "",
    twelve: t ? t.value.trim() : ""
  };
  save(); render();
}
function clearKeys() {
  if (!confirm("Remove both API keys from this device?")) return;
  state.keys = { finnhub: "", twelve: "" };
  save(); render();
}

function addRule() {
  var el = document.getElementById("rule-text");
  var t = el.value.trim();
  if (!t) return;
  state.rules.push({ text: t, done: false });
  save(); render();
}
function toggleRule(i) { state.rules[i].done = !state.rules[i].done; save(); render(); }
function delRule(i) { state.rules.splice(i, 1); save(); render(); }

function exportJSON() {
  var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  var d = new Date();
  a.download = "paper-backup-" + d.toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a); a.click(); a.remove();
}
function importJSON(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var r = new FileReader();
  r.onload = function () {
    try {
      var s = JSON.parse(r.result);
      if (!s.accounts || !s.rules) throw new Error("bad file");
      state = s; save(); render();
    } catch (e) { alert("That file isn't a PAPER backup."); }
  };
  r.readAsText(f);
  input.value = "";
}

/* ---------------- Paper API (window.Paper) ---------------- */
/* Programmatic trading for bots ("trains"). Same core functions as the UI,
   same localStorage — paper only: nothing here touches real money.
   Trains run in this page's console/devtools while the page is open. */

function apiAccount(account) {
  if (!MARKETS[account]) throw new Error("unknown account: " + account + " (" + MARKET_KEYS.join("|") + ")");
  return state.accounts[account];
}
function apiSide(account, side) {
  var want = String(side).trim().toLowerCase(), ok = null, i;
  for (i = 0; i < MARKETS[account].sides.length; i++) {
    if (MARKETS[account].sides[i].toLowerCase() === want) ok = MARKETS[account].sides[i];
  }
  if (!ok) throw new Error("bad side for " + account + ": " + side + " (" + MARKETS[account].sides.join("|") + ")");
  return ok;
}
function apiPriceOrQuote(symbol, price, what) {
  if (price !== undefined && price !== null) {
    if (!(price >= 0)) throw new Error("invalid " + what + " price");
    return price;
  }
  var q = lastQuote(symbol);
  if (!q) throw new Error("no live quote for " + String(symbol).toUpperCase() + " — pass a price explicitly");
  return q.price;
}

var Paper = {
  accounts: function () {
    var per = allStats().per;
    return MARKET_KEYS.map(function (k) {
      var s = per[k], acct = state.accounts[k];
      return { account: k, name: MARKETS[k].name, start: acct.start, cash: acct.cash,
        equity: s.equity, realized: s.realized, unrealized: s.unrealized,
        winRate: s.winRate, open: acct.positions.length, trades: s.trades };
    });
  },
  positions: function (account) {
    return apiAccount(account).positions.map(function (p) {
      var mk = markFor(p);
      return { id: p.id, market: p.market, symbol: p.symbol, side: p.side, qty: p.qty,
        entry: p.entry, ts: p.ts, mark: mk, unrealized: unrealized(p, mk) };
    });
  },
  trades: function (account) {
    return apiAccount(account).history.map(function (t) {
      return { id: t.id, symbol: t.symbol, side: t.side, qty: t.qty, entry: t.entry,
        exit: t.exit, exitLabel: t.exitLabel, pnl: t.pnl, ts: t.ts };
    });
  },
  place: function (o) {
    o = o || {};
    var acct = o.account;
    apiAccount(acct);
    var pos = placePosition(acct, o.symbol, apiSide(acct, o.side), o.qty, apiPriceOrQuote(o.symbol, o.price, "entry"));
    if (typeof document !== "undefined") render();
    return pos;
  },
  close: function (account, positionId, exitPrice) {
    var acct = apiAccount(account), pos = null, i;
    for (i = 0; i < acct.positions.length; i++) if (acct.positions[i].id === positionId) pos = acct.positions[i];
    if (!pos) throw new Error("position not found: " + positionId);
    var rec = closePositionCore(account, positionId, apiPriceOrQuote(pos.symbol, exitPrice, "exit"));
    if (typeof document !== "undefined") render();
    return rec;
  },
  quote: function (symbol) {
    var q = lastQuote(symbol);
    if (!q) return null;
    return { symbol: String(symbol).trim().toUpperCase(), price: q.price, ts: q.ts,
      staleSec: Math.round((Date.now() - q.ts) / 1000) };
  }
};
if (typeof window !== "undefined") window.Paper = Paper;

/* ---------------- render ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function pnlCls(n) { return n > 0 ? "pos" : n < 0 ? "neg" : ""; }

function allStats() {
  var marks = {};
  var total = { equity: 0, realized: 0, wins: 0, trades: 0, open: 0 };
  var per = {};
  MARKET_KEYS.forEach(function (k) {
    var acct = state.accounts[k];
    acct.positions.forEach(function (p) { marks[p.symbol] = markFor(p); });
    var s = accountStats(acct, marks);
    per[k] = s;
    total.equity += s.equity; total.realized += s.realized;
    total.wins += s.wins; total.trades += s.trades; total.open += acct.positions.length;
  });
  return { per: per, total: total };
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function feedLine() {
  var parts = [];
  parts.push("CRYPTO " + (lastCryptoTs ? '<span class="on">● LIVE ' + clock(lastCryptoTs) + "</span> (CoinGecko)" : "○ —"));
  var prov = stockProvider(state.keys || {});
  if (prov) parts.push("STOCKS " + (lastStockTs ? '<span class="on">● LIVE ' + clock(lastStockTs) + "</span> (your " + prov + " key)" : '<span class="on">●</span> connecting…'));
  else parts.push('STOCKS ○ manual — <span style="color:var(--gold)">add a free key in Rules → Data Feeds</span>');
  return parts.join(" &nbsp;·&nbsp; ");
}

function renderHeader(t) {
  document.getElementById("totalEquity").innerHTML = fmt(t.equity).replace(/(\.\d\d)$/, "<small>$1</small>");
  var p = document.getElementById("statPnl");
  p.textContent = fmtSign(t.realized); p.className = "v mono " + pnlCls(t.realized);
  document.getElementById("statWin").textContent = t.trades ? Math.round(100 * t.wins / t.trades) + "%" : "—";
  document.getElementById("statOpen").textContent = t.open;
  var fi = document.getElementById("live-ind");
  if (fi) fi.innerHTML = feedLine();
}

function renderTabs() {
  var tabs = document.getElementById("tabs");
  var html = "";
  MARKET_KEYS.forEach(function (k) {
    html += '<button class="tab' + (activeTab === k ? " active" : "") + '" data-tab="' + k + '">' + MARKETS[k].name + "</button>";
  });
  html += '<button class="tab' + (activeTab === "rules" ? " active" : "") + '" data-tab="rules">Rules</button>';
  tabs.innerHTML = html;
  var btns = tabs.querySelectorAll(".tab");
  btns.forEach(function (b) {
    b.addEventListener("click", function () { activeTab = b.getAttribute("data-tab"); render(); });
  });
}

function renderAccount(k, s, acct) {
  var m = MARKETS[k];
  acct = acct || state.accounts[k];
  var h = "";
  h += '<div class="card"><h2>BALANCE <span class="tag">· ' + m.name.toUpperCase() + "</span></h2>";
  h += '<div class="bal-row"><div class="cash mono ' + pnlCls(s.equity - acct.start) + '">' + fmt(s.equity) + "</div>";
  h += '<input id="start-' + k + '" class="mono" type="number" inputmode="decimal" value="' + acct.start + '" title="Starting balance">';
  h += '<button class="mini" data-act="setstart" data-m="' + k + '">Set start</button>';
  h += '<button class="mini danger" data-act="reset" data-m="' + k + '">Reset</button></div>';
  h += '<div style="margin-top:10px;font-size:13px;color:var(--dim)" class="mono">Cash ' + fmt(acct.cash) +
       ' · Unrealized <span class="' + pnlCls(s.unrealized) + '">' + fmtSign(s.unrealized) + "</span>" +
       " · Realized <span class=\"" + pnlCls(s.realized) + "\">" + fmtSign(s.realized) + "</span></div></div>";

  // ticket
  h += '<div class="card"><h2>NEW POSITION</h2>';
  if (m.chips) {
    h += '<div class="chips">';
    m.chips.forEach(function (c) {
      h += '<button class="chip" data-act="chip" data-m="' + k + '" data-sym="' + c + '">' + c + "</button>";
    });
    h += "</div>";
  }
  h += '<div class="ticket">';
  h += '<div class="field"><label>SYMBOL</label><input id="f-sym" placeholder="' + (k === "crypto" ? "BTC" : k === "stocks" ? "AAPL" : k === "options" ? "AAPL 10/17 200C" : k === "futures" ? "ES" : "Fed cuts in Oct?") + '"></div>';
  h += '<div class="field"><label>SIDE</label><select id="f-side">' + m.sides.map(function (x) { return "<option>" + x + "</option>"; }).join("") + "</select></div>";
  h += '<div class="field"><label>' + (k === "options" ? "CONTRACTS" : k === "prediction" ? "SHARES" : "QTY") + '</label><input id="f-qty" type="number" inputmode="decimal" placeholder="1"></div>';
  h += '<div class="field"><label>' + m.priceLabel.toUpperCase() + '</label><div class="live-row"><input id="f-entry" type="number" inputmode="decimal" placeholder="0.00">';
  if (m.live || m.keyLive) h += '<button class="mini goldbtn" data-act="liveprice" title="Fill live price">⚡</button>';
  h += "</div></div>";
  if (m.live || m.keyLive) {
    var noteTxt = liveErr && k === "crypto" ? esc(liveErr) : (stockErr && k === "stocks" ? esc(stockErr) : "");
    h += '<div class="field full"><div class="live-price' + (noteTxt ? " err" : "") + '" id="live-note">' + noteTxt + "</div></div>";
  }
  h += '<button class="open-btn" data-act="open" data-m="' + k + '">OPEN POSITION</button>';
  h += '<div class="field full" style="font-size:12px;color:var(--faint)">' + esc(m.hint) + "</div>";
  h += "</div></div>";

  // positions
  h += '<div class="card"><h2>OPEN POSITIONS <span class="tag">· ' + acct.positions.length + "</span></h2>";
  if (!acct.positions.length) h += '<div class="empty">No open positions. The market waits for no one.</div>';
  acct.positions.forEach(function (p) {
    var mk = markFor(p);
    var u = unrealized(p, mk);
    h += '<div class="pos-row"><div class="pos-top"><span class="pos-sym">' + esc(p.symbol) + '</span><span class="side ' + p.side.toLowerCase() + '">' + esc(p.side.toUpperCase()) + "</span></div>";
    h += '<div class="pos-meta mono">' + p.qty + " @ " + fmt(p.entry);
    if ((k === "crypto" || k === "stocks") && mk !== p.entry) h += " · now " + fmt(mk);
    h += ' · <span class="' + pnlCls(u) + '">' + fmtSign(u) + "</span></div>";
    if (k === "prediction") {
      h += '<div class="close-row"><button class="close-btn resolve-yes" data-act="resolve-yes" data-m="' + k + '" data-id="' + p.id + '">YES happened</button>' +
           '<button class="close-btn resolve-no" data-act="resolve-no" data-m="' + k + '" data-id="' + p.id + '">NO happened</button></div>';
    } else {
      h += '<div class="close-row"><input id="x-' + p.id + '" class="mono" type="number" inputmode="decimal" placeholder="Exit price">' +
           '<button class="close-btn" data-act="close" data-m="' + k + '" data-id="' + p.id + '">Close</button></div>';
    }
    h += "</div>";
  });
  h += "</div>";

  // history
  h += '<div class="card"><h2>TRADE HISTORY <span class="tag">· ' + acct.history.length + "</span></h2>";
  if (!acct.history.length) h += '<div class="empty">No closed trades yet.</div>';
  acct.history.slice(0, 50).forEach(function (t) {
    h += '<div class="hist-row"><div class="hist-left"><b>' + esc(t.symbol) + "</b> " + esc(t.side) + " × " + t.qty +
         '<br><span class="mono" style="font-size:12px">' + fmt(t.entry) + " → " + (t.exitLabel ? esc(t.exitLabel) : fmt(t.exit)) + "</span></div>" +
         '<div class="mono ' + pnlCls(t.pnl) + '" style="font-weight:700">' + fmtSign(t.pnl) + "</div></div>";
  });
  h += "</div>";
  return h;
}

function renderRules() {
  var h = '<div class="card"><h2>THE RULES <span class="tag">· READ BEFORE EVERY SESSION</span></h2>';
  state.rules.forEach(function (r, i) {
    h += '<div class="rule' + (r.done ? " done" : "") + '"><input type="checkbox" data-act="togglerule" data-i="' + i + '"' + (r.done ? " checked" : "") + ">" +
         "<span>" + esc(r.text) + "</span>" +
         '<button data-act="delrule" data-i="' + i + '" title="Delete">×</button></div>';
  });
  h += '<div class="rule-add"><input id="rule-text" placeholder="New rule…"><button class="mini goldbtn" data-act="addrule">Add</button></div></div>';

  h += '<div class="card"><h2>DATA FEEDS <span class="tag">· YOUR KEYS, YOUR DEVICE</span></h2>';
  h += '<div class="field"><label>FINNHUB API KEY (free tier · 60/min · US stocks)</label>' +
       '<input id="key-finnhub" type="password" autocomplete="off" spellcheck="false" placeholder="paste key" value="' + esc((state.keys || {}).finnhub || "") + '"></div>';
  h += '<div class="field"><label>TWELVE DATA API KEY (free tier · 8/min · backup)</label>' +
       '<input id="key-twelve" type="password" autocomplete="off" spellcheck="false" placeholder="paste key" value="' + esc((state.keys || {}).twelve || "") + '"></div>';
  h += '<div class="tools"><button class="mini goldbtn" data-act="savekeys">Save keys</button>' +
       '<button class="mini danger" data-act="clearkeys">Remove keys</button></div>';
  h += '<div style="font-size:12px;color:var(--faint);margin-top:8px">Keys live only in this device\u2019s localStorage — never in the repo, sent only to the provider\u2019s own API. They ride along in JSON backups you export. Free keys: finnhub.io · twelvedata.com. No key? Stocks stay manual — no shame in it.</div></div>';

  h += '<div class="card"><h2>BACKUP</h2><div class="tools">' +
       '<button class="mini" data-act="export">Export JSON</button>' +
       '<label class="mini" style="cursor:pointer">Import JSON<input type="file" id="import-file" accept=".json" class="hidden"></label>' +
       '<button class="mini danger" data-act="resetall">Reset everything</button></div></div>';
  return h;
}

function render() {
  var all = allStats();
  renderHeader(all.total);
  renderTabs();
  var main = document.getElementById("main");
  main.innerHTML = activeTab === "rules" ? renderRules() : renderAccount(activeTab, all.per[activeTab]);
  bindActions(main);
}

function fillLivePrice(rerender) {
  var symEl = document.getElementById("f-sym");
  var sym = symEl.value.trim().toUpperCase();
  var note = document.getElementById("live-note");
  if (activeTab === "crypto") {
    var idc = cgId(sym);
    if (!idc) { if (note) note.textContent = "No live feed for " + (sym || "?") + " — enter manually."; return; }
    if (note) note.textContent = "Fetching…";
    fetchMarks([sym], function () {
      var mk = liveMarks["crypto:" + idc];
      var fEntry = document.getElementById("f-entry");
      var note2 = document.getElementById("live-note");
      if (mk) { if (fEntry) fEntry.value = mk.price; if (note2) note2.textContent = ""; }
      else if (note2) note2.textContent = "Live price failed — enter manually.";
      if (rerender) render();
    });
  } else if (activeTab === "stocks") {
    var prov = stockProvider(state.keys || {});
    if (!prov) { if (note) note.textContent = "Add your free Finnhub key in Rules → Data Feeds for live stock quotes."; return; }
    if (!sym) { if (note) note.textContent = "Enter a symbol first."; return; }
    if (note) note.textContent = "Fetching…";
    fetchStockMarks([sym], function () {
      var mk = liveMarks["stocks:" + sym];
      var fEntry = document.getElementById("f-entry");
      var note2 = document.getElementById("live-note");
      if (mk) { if (fEntry) fEntry.value = mk.price; if (note2) note2.textContent = ""; }
      else if (note2) note2.textContent = stockErr || "Quote failed — enter manually.";
      if (rerender) render();
    });
  }
}

function bindActions(root) {
  root.querySelectorAll("[data-act]").forEach(function (el) {
    var act = el.getAttribute("data-act");
    el.addEventListener("click", function (ev) {
      var m = el.getAttribute("data-m"), id = el.getAttribute("data-id"), i = el.getAttribute("data-i");
      if (act === "open") openPosition(m);
      else if (act === "close") closePosition(m, id);
      else if (act === "resolve-yes") { if (confirm("Resolve YES — event happened (pays 100)?")) { resolvePosition(m, id, "yes"); render(); } }
      else if (act === "resolve-no") { if (confirm("Resolve NO — event didn't happen (pays 0)?")) { resolvePosition(m, id, "no"); render(); } }
      else if (act === "reset") resetAccount(m);
      else if (act === "setstart") setStart(m);
      else if (act === "togglerule") toggleRule(parseInt(i, 10));
      else if (act === "delrule") delRule(parseInt(i, 10));
      else if (act === "addrule") addRule();
      else if (act === "export") exportJSON();
      else if (act === "savekeys") saveKeys();
      else if (act === "clearkeys") clearKeys();
      else if (act === "resetall") {
        if (confirm("Reset EVERYTHING? All accounts, history, and rules go back to defaults.")) { state = defaultState(); save(); render(); }
      }
      else if (act === "liveprice") fillLivePrice(true);
      else if (act === "chip") {
        var symEl = document.getElementById("f-sym");
        if (symEl) symEl.value = el.getAttribute("data-sym");
        if (MARKETS[m] && MARKETS[m].live) fillLivePrice(false); // chip keeps the filled price (no re-render wipe)
        if (m === "stocks" && stockProvider(state.keys || {})) fillLivePrice(false);
      }
    });
    if (act === "togglerule") {
      // checkbox uses change, not click, to avoid double-toggle from re-render
      el.addEventListener("click", function (ev) { ev.stopPropagation(); }, true);
    }
  });
  var imp = document.getElementById("import-file");
  if (imp) imp.addEventListener("change", function () { importJSON(imp); });
  var rt = document.getElementById("rule-text");
  if (rt) rt.addEventListener("keydown", function (e) { if (e.key === "Enter") addRule(); });
}

/* ---------------- init ---------------- */

function refreshLiveMarks() {
  var cryptoSyms = [], stockSyms = [];
  MARKET_KEYS.forEach(function (k) {
    state.accounts[k].positions.forEach(function (p) {
      if (p.market === "crypto" && cgId(p.symbol)) cryptoSyms.push(p.symbol);
      if (p.market === "stocks") stockSyms.push(p.symbol);
    });
  });
  var done = function () { render(); };
  var step2 = function () { stockSyms.length ? fetchStockMarks(stockSyms, done) : done(); };
  cryptoSyms.length ? fetchMarks(cryptoSyms, step2) : step2();
}

if (typeof document !== "undefined") {
  load();
  render();
  refreshLiveMarks();
  setInterval(refreshLiveMarks, 60000);
  console.log("Paper API ready — try Paper.accounts()");
}

if (typeof module !== "undefined") {
  module.exports = { calcPnl: calcPnl, predPnl: predPnl, unrealized: unrealized, accountStats: accountStats, fmt: fmt, fmtSign: fmtSign,
    MARKETS: MARKETS, COINGECKO_IDS: COINGECKO_IDS, renderAccount: renderAccount,
    defaultState: defaultState, placePosition: placePosition, closePositionCore: closePositionCore,
    resolvePosition: resolvePosition, lastQuote: lastQuote, Paper: Paper,
    markFor: markFor, finnhubQuoteUrl: finnhubQuoteUrl, parseFinnhubQuote: parseFinnhubQuote,
    twelveQuoteUrl: twelveQuoteUrl, parseTwelveQuote: parseTwelveQuote, stockProvider: stockProvider,
    _setState: function (s) { state = s; }, _getState: function () { return state; },
    _setMarks: function (m) { liveMarks = m; } };
}
