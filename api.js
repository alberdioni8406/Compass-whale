/* ============================================================
   api.js
   All external network calls live here, isolated from rendering
   logic (app.js). Every function returns parsed JSON or throws —
   callers decide how to handle failures.

   Data sources (both free, no API key required):
   - Haskoin BCH Store API  -> https://api.haskoin.com/bch
     Blockchain data: blocks, transactions, address balances/history.
   - CoinPaprika            -> https://api.coinpaprika.com/v1
     Live BCH/USD price ticker.
   ============================================================ */

const HASKOIN_BASE = "https://api.haskoin.com/bch";
const COINPAPRIKA_TICKER_URL = "https://api.coinpaprika.com/v1/tickers/bch-bitcoin-cash";

// Satoshis per BCH, used to convert every raw on-chain value
// (Haskoin returns satoshis) into human BCH amounts.
const SATS_PER_BCH = 100000000;

/**
 * Generic JSON fetcher with a timeout, since a hung request to a
 * public API shouldn't hang the whole dashboard.
 */
async function fetchJson(url, options) {
  const timeoutMs = (options && options.timeoutMs) || 12000;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error("Request failed (" + res.status + ") for " + url);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Converts integer satoshis to a BCH float. */
function satsToBch(sats) {
  return sats / SATS_PER_BCH;
}

/* ----------------------------------------------------------
   PRICE
   ---------------------------------------------------------- */

/**
 * Fetches the live BCH/USD price and 24h change from CoinPaprika.
 * Returns { price, change24h, volume24h, marketCap } in USD.
 */
async function fetchBchPrice() {
  const data = await fetchJson(COINPAPRIKA_TICKER_URL);
  const usd = data && data.quotes && data.quotes.USD;
  if (!usd) throw new Error("CoinPaprika response missing USD quote");
  return {
    price: usd.price,
    change24h: usd.percent_change_24h,
    volume24h: usd.volume_24h,
    marketCap: usd.market_cap
  };
}

/* ----------------------------------------------------------
   NETWORK / NODE HEALTH
   ---------------------------------------------------------- */

/**
 * Fetches Haskoin's health endpoint: block height, headers, peer
 * count, mempool size, and sync status -- the backbone of the
 * "Network statistics" panel.
 */
async function fetchNetworkHealth() {
  const data = await fetchJson(HASKOIN_BASE + "/health");
  return {
    ok: data.ok,
    height: (data.blocks && data.blocks.blocks) ?? null,
    headers: (data.blocks && data.blocks.headers) ?? null,
    peers: (data.peers && data.peers.count) ?? null,
    mempoolCount: (data["pending-txs"] && data["pending-txs"].count) ?? null,
    lastBlockAgeSec: (data["last-block"] && data["last-block"].age) ?? null,
    synced: (data.blocks && data.blocks.ok) ?? null
  };
}

/** Fetches the best (most recent) block's header info, including its hash. */
async function fetchBestBlock() {
  const data = await fetchJson(HASKOIN_BASE + "/block/best?notx=true");
  return {
    hash: data.hash,
    height: data.height,
    time: data.time,
    difficulty: data.difficulty,
    previous: data.previous
  };
}

/**
 * Fetches a block's metadata by hash, including its list of txids
 * (the `tx` field -- just hashes, not full transaction objects).
 * Used to walk backward through the chain via each block's
 * `previous` hash without needing a height-indexed lookup.
 */
async function fetchBlockByHash(hash) {
  const data = await fetchJson(HASKOIN_BASE + "/block/" + hash + "?notx=false");
  return {
    hash: data.hash,
    height: data.height,
    time: data.time,
    previous: data.previous,
    txids: Array.isArray(data.tx) ? data.tx : []
  };
}

/**
 * Fetches full transaction detail (resolved input/output addresses
 * and satoshi values) for a batch of txids in one request. Haskoin
 * caps batch size in practice, so callers should chunk large lists;
 * we chunk at 50 to stay well under any server-side limit.
 */
async function fetchTransactionsFull(txids) {
  if (!txids || txids.length === 0) return [];
  const CHUNK = 50;
  const chunks = [];
  for (let i = 0; i < txids.length; i += CHUNK) {
    chunks.push(txids.slice(i, i + CHUNK));
  }
  const results = await Promise.all(
    chunks.map(function (chunk) {
      return fetchJson(HASKOIN_BASE + "/transactions?txids=" + chunk.join(","));
    })
  );
  return results.flat();
}

/* ----------------------------------------------------------
   ADDRESS LOOKUP
   ---------------------------------------------------------- */

/**
 * Fetches an address's live balance summary: confirmed balance,
 * total received, and tx count.
 */
async function fetchAddressBalance(address) {
  const clean = encodeURIComponent(address.trim());
  const data = await fetchJson(HASKOIN_BASE + "/address/" + clean + "/balance");
  const received = data.received || 0;
  const confirmed = data.confirmed || 0;
  return {
    address: data.address,
    balanceSats: confirmed,
    receivedSats: received,
    sentSats: received - confirmed >= 0 ? received - confirmed : 0,
    txCount: data.txs || 0,
    unconfirmedSats: data.unconfirmed || 0,
    utxoCount: data.utxo || 0
  };
}

/**
 * Fetches the most recent full transactions for a single address,
 * used by the search panel to show real recent activity.
 */
async function fetchAddressTransactions(address, limit) {
  const lim = limit || 20;
  const clean = encodeURIComponent(address.trim());
  const data = await fetchJson(
    HASKOIN_BASE + "/address/" + clean + "/transactions/full?limit=" + lim
  );
  return Array.isArray(data) ? data : [];
}
