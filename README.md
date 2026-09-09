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

## Develop

No toolchain. Edit the files, open `index.html`, done.
P&L math lives in pure functions at the top of `app.js` (node-testable).
