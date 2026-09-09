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
  stocks:     { name: "Stocks",      sides: ["Long", "Short"], priceLabel: "Entry price (USD)", live: false,
                chips: ["NVDA", "TSLA", "AAPL", "SPY", "MSFT", "AMD"],
                hint: "Manual quotes — check your broker app and type the price. Honest > fancy." },
  options:    { name: "Options",     sides: ["Call", "Put"],   priceLabel: "Premium per contract (USD)", live: false,
                chips: ["NVDA", "TSLA", "AAPL", "SPY", "MSFT", "AMD"],
                hint: "Paper simplification: calls act like longs, puts like shorts. Contracts × premium." },
  futures:    { name: "Futures",     sides: ["Long", "Short"],  priceLabel: "Entry price", live: false,
                chips: ["ES", "NQ", "BTC", "ETH"],
                hint: "Manual quotes. Qty = contracts, 1× — size it like the real thing." },
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
var liveMarks = {};   // symbol -> {price, ts}
var liveErr = "";

function defaultState() {
  var accounts = {};
  MARKET_KEYS.forEach(function (k) {
    accounts[k] = { start: 10000, cash: 10000, positions: [], history: [] };
  });
  return { accounts: accounts, rules: DEFAULT_RULES.map(function (t) { return { text: t, done: false }; }) };
}
function load() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) { state = JSON.parse(raw); return; }
  } catch (e) {}
  state = defaultState();
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
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
    return !(liveMarks[id] && now - liveMarks[id].ts < 60000);
  });
  if (!fresh.length) { if (cb) cb(); return; }
  fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + fresh.join(",") + "&vs_currencies=usd")
    .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
    .then(function (j) {
      fresh.forEach(function (id) {
        if (j[id] && typeof j[id].usd === "number") liveMarks[id] = { price: j[id].usd, ts: now };
      });
      liveErr = "";
      if (cb) cb();
    })
    .catch(function () { liveErr = "live prices unavailable — manual entry it is"; if (cb) cb(); });
}
function markFor(pos) {
  if (pos.market !== "crypto") return pos.entry;
  var id = cgId(pos.symbol);
  if (id && liveMarks[id]) return liveMarks[id].price;
  return pos.entry;
}

/* ---------------- actions ---------------- */

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function openPosition(market) {
  var sym = document.getElementById("f-sym").value.trim().toUpperCase();
  var side = document.getElementById("f-side").value;
  var qty = parseFloat(document.getElementById("f-qty").value);
  var entry = parseFloat(document.getElementById("f-entry").value);
  if (!sym) return alert("Enter a symbol.");
  if (!(qty > 0)) return alert("Quantity must be above 0.");
  if (!(entry >= 0)) return alert("Enter a valid price.");
  if (market === "prediction" && (entry < 0 || entry > 100)) return alert("Prediction price must be 0–100¢.");
  state.accounts[market].positions.push({ id: uid(), market: market, symbol: sym, side: side, qty: qty, entry: entry, ts: Date.now() });
  save(); render();
}

function closePosition(market, id) {
  var acct = state.accounts[market];
  var i, pos = null;
  for (i = 0; i < acct.positions.length; i++) if (acct.positions[i].id === id) pos = acct.positions[i];
  if (!pos) return;
  var exit;
  if (market === "prediction") return; // resolved via buttons instead
  exit = parseFloat(document.getElementById("x-" + id).value);
  if (!(exit >= 0)) return alert("Enter a valid exit price.");
  var pnl = calcPnl(pos.side, pos.qty, pos.entry, exit);
  acct.cash += pnl;
  acct.history.unshift({ id: uid(), symbol: pos.symbol, side: pos.side, qty: pos.qty, entry: pos.entry, exit: exit, pnl: pnl, ts: Date.now() });
  acct.positions = acct.positions.filter(function (p) { return p.id !== id; });
  save(); render();
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
  acct.history.unshift({ id: uid(), symbol: pos.symbol, side: pos.side, qty: pos.qty, entry: pos.entry,
    exit: resolvePrice, exitLabel: outcome === "yes" ? "Resolved YES" : "Resolved NO", pnl: pnl, ts: Date.now() });
  acct.positions = acct.positions.filter(function (p) { return p.id !== id; });
  save(); render();
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

function renderHeader(t) {
  document.getElementById("totalEquity").innerHTML = fmt(t.equity).replace(/(\.\d\d)$/, "<small>$1</small>");
  var p = document.getElementById("statPnl");
  p.textContent = fmtSign(t.realized); p.className = "v mono " + pnlCls(t.realized);
  document.getElementById("statWin").textContent = t.trades ? Math.round(100 * t.wins / t.trades) + "%" : "—";
  document.getElementById("statOpen").textContent = t.open;
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
  if (m.live) h += '<button class="mini goldbtn" data-act="liveprice" title="Fill live price">⚡</button>';
  h += "</div></div>";
  if (m.live) h += '<div class="field full"><div class="live-price' + (liveErr ? " err" : "") + '" id="live-note">' + (liveErr ? esc(liveErr) : "") + "</div></div>";
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
    if (k === "crypto" && mk !== p.entry) h += " · now " + fmt(mk);
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
  var idc = cgId(sym);
  var note = document.getElementById("live-note");
  if (!idc) { if (note) note.textContent = "No live feed for " + (sym || "?") + " — enter manually."; return; }
  if (note) note.textContent = "Fetching…";
  fetchMarks([sym], function () {
    var mk = liveMarks[idc];
    var fEntry = document.getElementById("f-entry");
    var note2 = document.getElementById("live-note");
    if (mk) { if (fEntry) fEntry.value = mk.price; if (note2) note2.textContent = ""; }
    else if (note2) note2.textContent = "Live price failed — enter manually.";
    if (rerender) render();
  });
}

function bindActions(root) {
  root.querySelectorAll("[data-act]").forEach(function (el) {
    var act = el.getAttribute("data-act");
    el.addEventListener("click", function (ev) {
      var m = el.getAttribute("data-m"), id = el.getAttribute("data-id"), i = el.getAttribute("data-i");
      if (act === "open") openPosition(m);
      else if (act === "close") closePosition(m, id);
      else if (act === "resolve-yes") { if (confirm("Resolve YES — event happened (pays 100)?")) resolvePosition(m, id, "yes"); }
      else if (act === "resolve-no") { if (confirm("Resolve NO — event didn't happen (pays 0)?")) resolvePosition(m, id, "no"); }
      else if (act === "reset") resetAccount(m);
      else if (act === "setstart") setStart(m);
      else if (act === "togglerule") toggleRule(parseInt(i, 10));
      else if (act === "delrule") delRule(parseInt(i, 10));
      else if (act === "addrule") addRule();
      else if (act === "export") exportJSON();
      else if (act === "resetall") {
        if (confirm("Reset EVERYTHING? All accounts, history, and rules go back to defaults.")) { state = defaultState(); save(); render(); }
      }
      else if (act === "liveprice") fillLivePrice(true);
      else if (act === "chip") {
        var symEl = document.getElementById("f-sym");
        if (symEl) symEl.value = el.getAttribute("data-sym");
        if (MARKETS[m] && MARKETS[m].live) fillLivePrice(false); // chip keeps the filled price (no re-render wipe)
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
  var syms = [];
  MARKET_KEYS.forEach(function (k) {
    state.accounts[k].positions.forEach(function (p) { if (p.market === "crypto" && cgId(p.symbol)) syms.push(p.symbol); });
  });
  if (syms.length) fetchMarks(syms, render);
}

if (typeof document !== "undefined") {
  load();
  render();
  refreshLiveMarks();
  setInterval(refreshLiveMarks, 60000);
}

if (typeof module !== "undefined") {
  module.exports = { calcPnl: calcPnl, predPnl: predPnl, unrealized: unrealized, accountStats: accountStats, fmt: fmt, fmtSign: fmtSign,
    MARKETS: MARKETS, COINGECKO_IDS: COINGECKO_IDS, renderAccount: renderAccount };
}
