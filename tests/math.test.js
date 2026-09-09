const M = require("../app.js");
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = Math.abs(got - want) < 1e-9;
  if (ok) pass++; else { fail++; console.log("FAIL", name, "got", got, "want", want); }
}
function throws(name, fn) {
  try { fn(); fail++; console.log("FAIL", name, "did not throw"); }
  catch (e) { pass++; }
}

// long/short
eq("long win", M.calcPnl("Long", 2, 100, 110), 20);
eq("long loss", M.calcPnl("Long", 2, 100, 90), -20);
eq("short win", M.calcPnl("Short", 3, 100, 90), 30);
eq("short loss", M.calcPnl("Short", 3, 100, 110), -30);
eq("call = long", M.calcPnl("Call", 5, 2.5, 4.0), 7.5);
eq("put = short", M.calcPnl("Put", 5, 2.5, 1.0), 7.5);
eq("zero qty", M.calcPnl("Long", 0, 100, 200), 0);
throws("bad side", () => M.calcPnl("Sideways", 1, 1, 2));

// prediction markets
eq("yes resolves yes", M.predPnl("Yes", 10, 30, 100), 700);
eq("yes resolves no", M.predPnl("Yes", 10, 30, 0), -300);
eq("no resolves no", M.predPnl("No", 10, 30, 0), 300);
throws("price >100", () => M.predPnl("Yes", 1, 101, 100));
throws("bad resolve", () => M.predPnl("Yes", 1, 50, 42));

// account stats
const acct = {
  cash: 10000, start: 10000,
  positions: [
    { id: "a", market: "stocks", symbol: "AAPL", side: "Long", qty: 10, entry: 200, ts: 1 },
    { id: "b", market: "stocks", symbol: "TSLA", side: "Short", qty: 5, entry: 250, ts: 2 }
  ],
  history: [
    { pnl: 150 }, { pnl: -50 }, { pnl: 0 }
  ]
};
const s = M.accountStats(acct, { AAPL: 210, TSLA: 240 });
eq("unrealized", s.unrealized, (210 - 200) * 10 + (250 - 240) * 5); // 100 + 50
eq("realized", s.realized, 100);
eq("equity", s.equity, 10000 + 150);
eq("winRate", s.winRate, 1 / 3);
eq("wins", s.wins, 1);

// prediction marked at cost
const pa = { cash: 10000, start: 10000,
  positions: [{ id: "p", market: "prediction", symbol: "FED?", side: "Yes", qty: 20, entry: 40, ts: 1 }],
  history: [] };
eq("pred unrealized = 0", M.accountStats(pa, {}).unrealized, 0);
eq("pred equity = cash", M.accountStats(pa, {}).equity, 10000);

// fmt
console.log("fmt:", M.fmt(1234.5), "|", M.fmtSign(-42.1), "|", M.fmtSign(7));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
