# PAPER — Fake money. Real lessons.

A sick dark-terminal paper-trading simulator for the DOGS empire.
Five paper accounts: **Crypto, Stocks, Options, Futures, Prediction Markets.**
No build step, no backend — just `index.html` + `styles.css` + `app.js`.

## Use it

Open the GitHub Pages URL (or any static host) on your phone.
Everything is stored in your device's `localStorage` — nothing leaves your browser.

- **New position:** pick a tab, fill the ticket (symbol, side, qty, price), hit OPEN POSITION.
- **Crypto:** tap the ⚡ bolt to fill the live CoinGecko price. Everything else is manual quotes — type them from your broker app.
- **Close:** enter an exit price per position. Prediction markets close by resolving YES (pays 100) or NO (pays 0).
- **Options (paper simplification):** calls behave like longs, puts like shorts. Contracts × premium.
- **Rules tab:** your guardrails checklist — read it before every session. Add your own.
- **Backup:** export/import JSON in the Rules tab before switching devices.

## The one rule

This is PAPER. No real money moves here, and nothing here is financial advice.
Paper stays paper until 60 days green — then we talk.

## Paper API — for trains (bots)

Open devtools on the page and drive PAPER programmatically. Same engine as the
UI, same localStorage — paper only, fake money, always.

- `Paper.accounts()` → all five accounts with equity, realized/unrealized, win rate
- `Paper.positions("crypto")` → open positions with live marks + unrealized P&L
- `Paper.trades("crypto")` → closed-trade history
- `Paper.place({account, symbol, side, qty, price})` → open a position (omit `price` to use the last live quote)
- `Paper.close("crypto", positionId, exitPrice)` → close it (omit `exitPrice` for the live quote; prediction markets: pass `100` for YES, `0` for NO)
- `Paper.quote("BTC")` → last known quote + staleness in seconds

Example train — a dip-buyer. Paste it in the console; it runs while the page is open:

```js
// TRAIN-01 "dip-buyer" — PAPER ONLY. Fake money, real lessons.
const Train = { high: 0 };
setInterval(() => {
  const q = Paper.quote("BTC");
  if (!q) return; // open the app once so quotes load
  Train.high = Math.max(Train.high, q.price);
  const open = Paper.positions("crypto").find(p => p.symbol === "BTC");
  if (!open && q.price < Train.high * 0.98) {
    Paper.place({ account: "crypto", symbol: "BTC", side: "Long", qty: 0.01 });
    console.log("TRAIN-01 bought the dip @", q.price);
  } else if (open && q.price > open.entry * 1.03) {
    const r = Paper.close("crypto", open.id);
    console.log("TRAIN-01 took profit:", r.pnl);
  }
}, 60000);
```

Trains live in the page — close the tab and they stop. (A headless version is a future build.)

## Develop

No toolchain. Edit the files, open `index.html`, done.
P&L math lives in pure functions at the top of `app.js` (node-testable).
API tests: `node api-test.js`.
