# BCH Whale Monitor

A static, backend-free Bitcoin Cash whale-tracking dashboard. Pure HTML, CSS,
and vanilla JavaScript — no build step, no frameworks, no API keys, no
database. Deploy it anywhere that serves static files.

## Files

- `index.html` — page structure and content.
- `styles.css` — all styling (dark mode, responsive grid, the pulse-rail
  signature animation).
- `data.js` — the curated "known address" label book (exchanges, pools).
  **Ships empty** — see "About the rich list" below.
- `api.js` — every external network call, isolated from rendering logic.
- `app.js` — application state, the whale-detection engine, and all DOM
  rendering.

## Data sources (both free, no key required)

- **Haskoin BCH Store API** — `https://api.haskoin.com/bch`
  Blocks, transactions, address balances and history. This is the same
  Haskoin pattern already used across your other BCH projects.
- **CoinPaprika** — `https://api.coinpaprika.com/v1/tickers/bch-bitcoin-cash`
  Live BCH/USD price and 24h change.

No CORS proxy is needed for either — both APIs already send permissive CORS
headers for browser use.

## How the whale detector works

On each refresh cycle (every 3 minutes by default), the app:

1. Fetches the current best block from Haskoin.
2. Walks backward a few blocks via each block's `previous` hash field (the
   only chain-walking primitive the free API exposes — there's no
   height-indexed block lookup, so hash-walking is the correct approach,
   not a shortcut).
3. Resolves a sample of each block's transactions to full detail (addresses
   + values) via the batched `/transactions?txids=...` endpoint.
4. Classifies each transaction's total output value in USD (using the live
   price) against two thresholds — `WHALE_USD_THRESHOLD` ($50k) and
   `WHALE_USD_SEVERE_THRESHOLD` ($250k) — both configurable in `app.js`.
5. Feeds every transaction it resolves into the activity leaderboard and
   the value-distribution chart, regardless of whether it crosses the
   whale threshold.

Everything described as "scanned," "seen," or "session" is scoped honestly
to the current page load — there's no backend to persist history across
visits, so the app never claims data it doesn't actually have.

### Why only a sample of each block's transactions?

A busy BCH block can contain thousands of transactions. Resolving every one
to full detail would mean dozens of extra API calls per block against a
free, shared, rate-limited service — slow, impolite to the API operator,
and rough on mobile data. `MAX_TXIDS_PER_BLOCK` (300 by default, in
`app.js`) caps this. Whale-sized transactions are a small fraction of any
block's transaction count, so a wide sample still catches the large majority
of them in practice. Raise the cap if you want deeper coverage at the cost
of more requests.

## About the "rich list" / known major holders panel

There is no free API that returns a true Bitcoin Cash rich list. Building
one for real means indexing every address that has ever received BCH —
millions of them — and sorting by balance. That's a multi-day, server-side
indexing job, not something a static frontend can compute on page load.

So this panel does something narrower and honest instead: it holds a small,
manually curated list of addresses **you've personally verified** belong to
an exchange or mining pool, and fetches their **real, live balance** from
the chain every refresh. The list ships empty in `data.js`. Until you add
verified entries, the panel says so plainly rather than showing fabricated
data. Add entries like this:

```js
const KNOWN_ADDRESSES = [
  {
    address: "bitcoincash:q...",
    label: "Exchange Name — published cold storage",
    type: "exchange" // or "pool"
  }
];
```

The same `KNOWN_ADDRESSES` list also powers the exchange/pool labels shown
in the whale alert feed and the activity leaderboard.

## Configuration

All tunables live at the top of `app.js` in the `CONFIG` object:

| Key | Default | Meaning |
|---|---|---|
| `WHALE_USD_THRESHOLD` | 50000 | Minimum USD value to trigger a whale alert |
| `WHALE_USD_SEVERE_THRESHOLD` | 250000 | Minimum USD value for the amber "severe" styling |
| `MAX_TXIDS_PER_BLOCK` | 300 | Transactions resolved to full detail per block |
| `BLOCKS_PER_SCAN` | 3 | Blocks walked backward per refresh cycle |
| `REFRESH_INTERVAL_MS` | 180000 (3 min) | Auto-refresh interval |
| `MAX_FEED_ITEMS` | 40 | Whale alerts kept in the feed/export |
| `MAX_LEADERBOARD_ROWS` | 15 | Rows shown in the activity leaderboard |

## Deploying

No build step — this is plain static HTML/CSS/JS.

**Vercel**: `vercel deploy` from this folder, or drag-and-drop the folder
into the Vercel dashboard. No `vercel.json` needed.

**Netlify**: drag-and-drop the folder into Netlify's deploy UI, or
`netlify deploy` from this folder.

**GitHub Pages**: push this folder to a repo and enable Pages on the
`main` branch, root directory.

**Any static host**: upload all five files to the same directory and point
your host at `index.html`.

## Browser support notes

Uses `fetch`, `AbortController`, `Promise.all`, and Canvas 2D — all
supported in every browser still receiving updates. No polyfills included
or needed for that baseline.

## Extending

- Add more known addresses to `data.js` as you verify them.
- Adjust whale thresholds in `CONFIG` to taste.
- The BCHNostr-ready export panel emits a generic structured JSON event
  (`kind`/`content`/`tags`/`created_at`) shaped closely enough to a Nostr
  event to drop into a relay publisher or community bot with minimal
  reshaping — adjust `renderExportBlock()` in `app.js` if your bot expects
  a different shape.
