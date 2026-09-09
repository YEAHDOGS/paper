/* PAPER API tests — node. Run: node api-test.js */
"use strict";
var P = require("./app.js");
var fails = 0;
function ok(cond, name) { if (cond) { console.log("  ok - " + name); } else { fails++; console.log("  FAIL - " + name); } }
function throws(fn, name) { try { fn(); } catch (e) { console.log("  ok - " + name + " (" + e.message + ")"); return; } fails++; console.log("  FAIL - " + name + " (no throw)"); }

P._setState(P.defaultState());

// accounts
var accts = P.Paper.accounts();
ok(accts.length === 5, "5 accounts listed");
ok(accts[0].account === "crypto" && accts[0].equity === 10000 && accts[0].open === 0, "fresh crypto account: 10k equity, 0 open");

// place with explicit price
var pos = P.Paper.place({ account: "crypto", symbol: "btc", side: "long", qty: 0.5, price: 60000 });
ok(pos.symbol === "BTC" && pos.side === "Long" && pos.entry === 60000, "place normalizes + opens long BTC @ 60000");
ok(P.Paper.positions("crypto").length === 1, "position shows up in Paper.positions");

// place without price and no quote -> throws
throws(function () { P.Paper.place({ account: "crypto", symbol: "BTC", side: "long", qty: 1 }); }, "place w/o price and no quote throws");

// seed a quote, place without price -> uses cache
P._setMarks({ "crypto:BTC": { price: 61000, ts: Date.now() } });
var pos2 = P.Paper.place({ account: "crypto", symbol: "BTC", side: "short", qty: 1 });
ok(pos2.entry === 61000, "place uses cached quote when price omitted");

// quote + staleness
var q = P.Paper.quote("btc");
ok(q && q.symbol === "BTC" && q.price === 61000 && q.staleSec >= 0, "quote returns price + staleness");
ok(P.Paper.quote("ZZZZ") === null, "quote unknown symbol -> null");

// close: short 1 @ 61000, exit 60000 -> +1000
var rec = P.Paper.close("crypto", pos2.id, 60000);
ok(rec.pnl === 1000, "close realizes correct P&L (short +1000)");
ok(P.Paper.trades("crypto").length === 1 && P.Paper.trades("crypto")[0].pnl === 1000, "trade lands in history");
ok(P.Paper.accounts()[0].realized === 1000, "account realized updated");

// close without exit price -> uses cached quote: long 2 ETH @ 3000, quote 3100 -> +200
var pos3 = P.Paper.place({ account: "crypto", symbol: "ETH", side: "long", qty: 2, price: 3000 });
P._setMarks({ "crypto:BTC": { price: 61000, ts: Date.now() }, "crypto:ETH": { price: 3100, ts: Date.now() } });
var rec2 = P.Paper.close("crypto", pos3.id);
ok(rec2.pnl === 200, "close w/o exit uses cached quote (long +200)");

// prediction market via API: Yes 10 @ 60 -> resolve 100 = +400
var pp = P.Paper.place({ account: "prediction", symbol: "FED-CUT?", side: "Yes", qty: 10, price: 60 });
var pr = P.Paper.close("prediction", pp.id, 100);
ok(pr.pnl === 400, "prediction Yes 60 -> resolve 100 = +400");
throws(function () { var x = P.Paper.place({ account: "prediction", symbol: "X", side: "Yes", qty: 1, price: 50 }); P.Paper.close("prediction", x.id, 42); }, "prediction close with exit != 0/100 throws");

// validation
throws(function () { P.Paper.place({ account: "nope", symbol: "BTC", side: "long", qty: 1, price: 1 }); }, "unknown account throws");
throws(function () { P.Paper.place({ account: "crypto", symbol: "BTC", side: "sideways", qty: 1, price: 1 }); }, "bad side throws");
throws(function () { P.Paper.place({ account: "crypto", symbol: "BTC", side: "long", qty: 0, price: 1 }); }, "zero qty throws");
throws(function () { P.Paper.place({ account: "crypto", symbol: "", side: "long", qty: 1, price: 1 }); }, "empty symbol throws");
throws(function () { P.Paper.close("crypto", "missing-id", 1); }, "close missing position throws");
throws(function () { P.Paper.positions("nope"); }, "positions unknown account throws");

// options: call/put sides canonicalized
var op = P.Paper.place({ account: "options", symbol: "NVDA", side: "call", qty: 2, price: 5 });
ok(op.side === "Call", "side canonicalized to Call");
var or = P.Paper.close("options", op.id, 7);
ok(or.pnl === 4, "call 2 @ 5 -> 7 = +4");

// positions carry live unrealized: long 0.5 BTC @ 60000, mark 62000 -> +1000
P._setMarks({ "crypto:BTC": { price: 62000, ts: Date.now() } });
var ups = P.Paper.positions("crypto");
var btc = ups.filter(function (p) { return p.symbol === "BTC"; })[0];
ok(btc && btc.unrealized === 1000 && btc.mark === 62000, "positions carry live mark + unrealized P&L");

console.log(fails ? ("\n" + fails + " FAILURES") : "\nall green");
process.exit(fails ? 1 : 0);
