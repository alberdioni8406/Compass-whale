/* ============================================================
   app.js
   Application orchestration: pulls data via api.js, runs the
   whale-detection engine, and renders every panel in index.html.
   No external UI framework -- direct DOM updates.
   ============================================================ */

/* ----------------------------------------------------------
   CONFIG
   ---------------------------------------------------------- */
const CONFIG = {
  // A transaction counts as a "whale" alert once its USD value
  // crosses this line. Recalculated against live price, not a
  // fixed BCH amount, since "large" is a dollar judgment in
  // practice (a $30k move matters the same whether BCH is at
  // $200 or $600).
  WHALE_USD_THRESHOLD: 50000,
  // A second, higher tier gets the amber "severe" treatment.
  WHALE_USD_SEVERE_THRESHOLD: 250000,

  // Cap on how many txids per block get resolved to full transaction
  // detail. BCH blocks can hold thousands of transactions; fetching
  // full detail for every one would mean dozens of extra calls per
  // block against a free, shared API. This keeps each refresh fast
  // and considerate while still sampling enough of the block that
  // whale-sized transfers are very unlikely to be missed.
  MAX_TXIDS_PER_BLOCK: 300,

  // Cap on how many of the most recent blocks to scan per refresh cycle.
  // Kept small to stay polite to the free public API and fast on
  // mobile connections.
  BLOCKS_PER_SCAN: 3,

  // How often the whole dashboard refreshes itself, in ms.
  REFRESH_INTERVAL_MS: 3 * 60 * 1000, // 3 minutes

  // Cap on how many whale alerts to keep in the feed/export at once.
  MAX_FEED_ITEMS: 40,

  // Cap on rows shown in the activity leaderboard.
  MAX_LEADERBOARD_ROWS: 15
};

/* ----------------------------------------------------------
   SESSION STATE
   Everything the dashboard has learned so far THIS PAGE LOAD.
   There's no backend, so "session" is the only timeframe we can
   honestly claim for anything described as "scanned" or "seen."
   ---------------------------------------------------------- */
const state = {
  bchPriceUsd: null,
  lastScannedHeight: null,    // highest block height already processed
  txScannedCount: 0,
  whaleAlerts: [],            // newest first
  addressActivity: new Map(), // address -> { count, totalSats, label }
  valueBuckets: {             // for the distribution chart, in tx count
    "< 1 BCH": 0,
    "1 - 10": 0,
    "10 - 100": 0,
    "100 - 1,000": 0,
    "1,000 - 10,000": 0,
    "10,000+": 0
  },
  largestTxToday: null,       // { valueBch, valueUsd, txid, time }
  refreshTimer: null
};

/* ----------------------------------------------------------
   FORMATTING HELPERS
   ---------------------------------------------------------- */
function fmtBch(amount) {
  if (amount == null || isNaN(amount)) return "—";
  return amount.toLocaleString(undefined, { maximumFractionDigits: amount >= 1 ? 2 : 8 }) + " BCH";
}

function fmtUsd(amount) {
  if (amount == null || isNaN(amount)) return "—";
  if (amount >= 1000000) return "$" + (amount / 1000000).toFixed(2) + "M";
  if (amount >= 1000) return "$" + (amount / 1000).toFixed(1) + "k";
  return "$" + amount.toFixed(2);
}

function fmtAddrShort(addr) {
  if (!addr) return "unknown";
  const clean = addr.replace(/^bitcoincash:/, "");
  if (clean.length <= 16) return clean;
  return clean.slice(0, 8) + "…" + clean.slice(-6);
}

function fmtTimeAgo(unixSeconds) {
  if (!unixSeconds) return "—";
  const deltaSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (deltaSec < 60) return deltaSec + "s ago";
  if (deltaSec < 3600) return Math.floor(deltaSec / 60) + "m ago";
  if (deltaSec < 86400) return Math.floor(deltaSec / 3600) + "h ago";
  return Math.floor(deltaSec / 86400) + "d ago";
}

function fmtDuration(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
}

/* ----------------------------------------------------------
   CONNECTION STATUS UI
   ---------------------------------------------------------- */
function setConnStatus(mode, label) {
  const dot = document.getElementById("connDot");
  const text = document.getElementById("connLabel");
  dot.classList.remove("live", "error");
  if (mode === "live") dot.classList.add("live");
  if (mode === "error") dot.classList.add("error");
  text.textContent = label;
}

/* ----------------------------------------------------------
   SIGNATURE PULSE ANIMATION
   Fires the traveling dot on the top rail whenever a new whale
   alert is detected. Severity controls color (teal vs amber).
   ---------------------------------------------------------- */
function firePulse(severe) {
  const dot = document.getElementById("pulseDot");
  dot.classList.remove("firing", "severe");
  // Force reflow so the animation can restart if it's already mid-flight.
  void dot.offsetWidth;
  if (severe) dot.classList.add("severe");
  dot.classList.add("firing");
}

/* ----------------------------------------------------------
   PRICE PANEL
   ---------------------------------------------------------- */
async function refreshPrice() {
  try {
    const price = await fetchBchPrice();
    state.bchPriceUsd = price.price;

    document.getElementById("priceValue").textContent = "$" + price.price.toFixed(2);
    const changeEl = document.getElementById("priceChange");
    const sign = price.change24h >= 0 ? "+" : "";
    changeEl.textContent = sign + price.change24h.toFixed(2) + "%";
    changeEl.className = "price-change " + (price.change24h >= 0 ? "up" : "down");

    document.getElementById("statPrice").textContent = "$" + price.price.toFixed(2);
    document.getElementById("statPriceSub").textContent =
      sign + price.change24h.toFixed(2) + "% (24h) · vol " + fmtUsd(price.volume24h);
  } catch (err) {
    console.error("Price fetch failed:", err);
    document.getElementById("priceValue").textContent = "unavailable";
  }
}

/* ----------------------------------------------------------
   NETWORK STATS PANEL
   ---------------------------------------------------------- */
async function refreshNetworkStats() {
  try {
    const results = await Promise.all([fetchNetworkHealth(), fetchBestBlock()]);
    const health = results[0];
    const best = results[1];

    document.getElementById("netHeight").textContent = best.height.toLocaleString();
    document.getElementById("netHeaders").textContent = (health.headers != null ? health.headers : best.height).toLocaleString();
    document.getElementById("netPeers").textContent = health.peers != null ? health.peers : "—";
    document.getElementById("netMempool").textContent = health.mempoolCount != null ? health.mempoolCount.toLocaleString() : "—";
    document.getElementById("netSync").textContent = health.synced ? "Synced" : "Catching up";
    document.getElementById("netLastBlockAge").textContent = fmtDuration(health.lastBlockAgeSec);

    document.getElementById("heroHeight").textContent = best.height.toLocaleString();
    document.getElementById("heroLastBlock").textContent = fmtTimeAgo(best.time);
    document.getElementById("statDifficulty").textContent = best.difficulty
      ? Number(best.difficulty).toLocaleString(undefined, { maximumFractionDigits: 0 })
      : "—";

    setConnStatus("live", "Live · block " + best.height.toLocaleString());

    return { height: best.height, hash: best.hash };
  } catch (err) {
    console.error("Network stats fetch failed:", err);
    setConnStatus("error", "Connection issue");
    return { height: null, hash: null };
  }
}

/* ----------------------------------------------------------
   WHALE DETECTION ENGINE
   Scans the most recent N blocks (that we haven't already
   processed this session) and classifies every transaction by
   total output value. Large ones become whale alerts; every one
   feeds the distribution chart and the activity leaderboard.
   ---------------------------------------------------------- */
function classifyBucket(bch) {
  if (bch < 1) return "< 1 BCH";
  if (bch < 10) return "1 - 10";
  if (bch < 100) return "10 - 100";
  if (bch < 1000) return "100 - 1,000";
  if (bch < 10000) return "1,000 - 10,000";
  return "10,000+";
}

/**
 * Given one Haskoin "full transaction" object, computes the total
 * value moved (sum of outputs, which approximates the transferred
 * amount well enough for whale-detection purposes -- change
 * outputs returning to the sender are a known source of noise in
 * any on-chain heuristic, BCH included, and are an accepted
 * tradeoff for a client-side, API-only detector).
 */
function totalOutputSats(tx) {
  if (!Array.isArray(tx.outputs)) return 0;
  return tx.outputs.reduce(function (sum, o) { return sum + (o.value || 0); }, 0);
}

/** Picks the single largest output's address as the tx's "primary recipient." */
function primaryRecipient(tx) {
  if (!Array.isArray(tx.outputs) || tx.outputs.length === 0) return null;
  let best = tx.outputs[0];
  for (const o of tx.outputs) {
    if ((o.value || 0) > (best.value || 0)) best = o;
  }
  return best.address || null;
}

/** Picks the first resolvable input address as the tx's "primary sender." */
function primarySender(tx) {
  if (!Array.isArray(tx.inputs)) return null;
  for (const i of tx.inputs) {
    if (i.address) return i.address;
  }
  return null;
}

function recordActivity(address, sats) {
  if (!address) return;
  const key = normalizeAddress(address);
  const existing = state.addressActivity.get(key);
  if (existing) {
    existing.count += 1;
    existing.totalSats += sats;
  } else {
    state.addressActivity.set(key, { address: address, count: 1, totalSats: sats });
  }
}

/**
 * Processes one block's worth of full transactions: updates the
 * distribution chart buckets, the activity leaderboard, the
 * largest-tx-today stat, and pushes whale alerts for anything
 * crossing the USD threshold.
 */
function processTransactions(txs, blockTime) {
  if (!state.bchPriceUsd) return; // need a price to judge "whale"

  for (const tx of txs) {
    const sats = totalOutputSats(tx);
    if (sats <= 0) continue;
    const bch = satsToBch(sats);
    const usd = bch * state.bchPriceUsd;

    state.txScannedCount += 1;
    state.valueBuckets[classifyBucket(bch)] += 1;

    const sender = primarySender(tx);
    const recipient = primaryRecipient(tx);
    recordActivity(sender, sats);
    recordActivity(recipient, sats);

    if (!state.largestTxToday || usd > state.largestTxToday.valueUsd) {
      state.largestTxToday = {
        valueBch: bch,
        valueUsd: usd,
        txid: tx.txid,
        time: tx.time || blockTime
      };
    }

    if (usd >= CONFIG.WHALE_USD_THRESHOLD) {
      pushWhaleAlert({
        txid: tx.txid,
        valueBch: bch,
        valueUsd: usd,
        sender: sender,
        recipient: recipient,
        time: tx.time || blockTime,
        severe: usd >= CONFIG.WHALE_USD_SEVERE_THRESHOLD
      });
    }
  }
}

function pushWhaleAlert(alert) {
  alert.senderLabel = lookupAddressLabel(alert.sender);
  alert.recipientLabel = lookupAddressLabel(alert.recipient);
  state.whaleAlerts.unshift(alert);
  if (state.whaleAlerts.length > CONFIG.MAX_FEED_ITEMS) {
    state.whaleAlerts.length = CONFIG.MAX_FEED_ITEMS;
  }
  renderWhaleFeed();
  renderExportBlock();
  firePulse(alert.severe);

  document.getElementById("statWhaleCount").textContent = state.whaleAlerts.length;
}

/**
 * Main scan cycle: starting at the current best block, walks
 * backward via each block's `previous` hash (the only chain-walk
 * primitive the free API actually exposes -- there's no verified
 * height-indexed block lookup) until it reaches CONFIG.BLOCKS_PER_SCAN
 * blocks or a block it has already processed this session.
 */
async function scanRecentBlocks(currentHeight, bestHash) {
  if (currentHeight == null || !bestHash) return;

  let cursorHash = bestHash;
  let blocksScanned = 0;

  while (cursorHash && blocksScanned < CONFIG.BLOCKS_PER_SCAN) {
    try {
      const block = await fetchBlockByHash(cursorHash);

      // Stop once we reach a block this session has already scanned.
      if (state.lastScannedHeight != null && block.height <= state.lastScannedHeight) {
        break;
      }

      // BCH blocks can hold thousands of transactions. Fetching full
      // detail for every single one would mean dozens of extra API
      // calls per block on a free, rate-limited public endpoint, which
      // is a poor neighbor and slow on mobile connections. Capping
      // per-block coverage trades some completeness for a dashboard
      // that stays fast and polite to the API; whale-sized transactions
      // are visually obvious in a block, so a wide sample still catches
      // the overwhelming majority of them in practice.
      const sampleTxids = block.txids.slice(0, CONFIG.MAX_TXIDS_PER_BLOCK);
      const txs = await fetchTransactionsFull(sampleTxids);
      processTransactions(txs, block.time);

      blocksScanned += 1;
      cursorHash = block.previous;
    } catch (err) {
      console.error("Block scan failed at hash " + cursorHash + ":", err);
      break;
    }
  }

  state.lastScannedHeight = currentHeight;

  renderStatPanels();
  renderDistributionChart();
  renderLeaderboard();
}

/* ----------------------------------------------------------
   RENDER: STAT GRID
   ---------------------------------------------------------- */
function renderStatPanels() {
  document.getElementById("statTxCount").textContent = state.txScannedCount.toLocaleString();
  document.getElementById("statTxCountSub").textContent =
    "across " + (state.lastScannedHeight ? CONFIG.BLOCKS_PER_SCAN + "+ recent blocks" : "0 blocks");

  if (state.largestTxToday) {
    document.getElementById("statLargestTx").textContent = fmtBch(state.largestTxToday.valueBch);
    document.getElementById("statLargestTxSub").textContent =
      fmtUsd(state.largestTxToday.valueUsd) + " · " + fmtTimeAgo(state.largestTxToday.time);
  }

  // Most active wallet by appearances seen this session.
  let topAddr = null, topEntry = null;
  state.addressActivity.forEach(function (entry, key) {
    if (!topEntry || entry.count > topEntry.count) {
      topAddr = key;
      topEntry = entry;
    }
  });
  if (topEntry) {
    document.getElementById("statActiveWallet").textContent = fmtAddrShort(topEntry.address);
    document.getElementById("statActiveWalletSub").textContent =
      topEntry.count + " appearances · " + fmtBch(satsToBch(topEntry.totalSats));
  }
}

/* ----------------------------------------------------------
   RENDER: WHALE FEED
   ---------------------------------------------------------- */
function labelBadgeHtml(labelEntry) {
  if (!labelEntry) return '<span class="tiny-badge unknown">Unlabeled</span>';
  const cls = labelEntry.type === "exchange" ? "exchange" : "";
  return '<span class="tiny-badge ' + cls + '">' + escapeHtml(labelEntry.label) + "</span>";
}

function renderWhaleFeed() {
  const list = document.getElementById("whaleFeedList");
  const emptyMsg = document.getElementById("feedEmptyMsg");

  if (state.whaleAlerts.length === 0) {
    if (emptyMsg) emptyMsg.style.display = "block";
    return;
  }
  if (emptyMsg) emptyMsg.style.display = "none";

  list.innerHTML = state.whaleAlerts.map(function (a) {
    const severityClass = a.severe ? "severity-extreme" : "";
    const fromTag = a.sender ? fmtAddrShort(a.sender) : "unresolved input";
    const toTag = a.recipient ? fmtAddrShort(a.recipient) : "unresolved output";
    return (
      '<div class="feed-item ' + severityClass + '">' +
        '<div class="feed-item-top">' +
          '<span class="feed-amount">' + fmtBch(a.valueBch) + "</span>" +
          '<span class="feed-usd">' + fmtUsd(a.valueUsd) + "</span>" +
          '<span class="feed-time">' + fmtTimeAgo(a.time) + "</span>" +
        "</div>" +
        '<div class="feed-route">' +
          '<span class="addr-tag">' + fromTag + "</span>" +
          " &rarr; " +
          '<span class="addr-tag">' + toTag + "</span>" +
        "</div>" +
        '<div class="feed-labels">' +
          labelBadgeHtml(a.senderLabel) +
          labelBadgeHtml(a.recipientLabel) +
        "</div>" +
      "</div>"
    );
  }).join("");
}

/* ----------------------------------------------------------
   RENDER: DISTRIBUTION CHART (hand-rolled canvas bar chart --
   no charting library dependency, keeps the bundle at zero deps)
   ---------------------------------------------------------- */
function renderDistributionChart() {
  const canvas = document.getElementById("distChart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  // Match canvas resolution to its displayed CSS size for crisp lines.
  const cssWidth = canvas.clientWidth || 480;
  const cssHeight = 280;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0); // reset before re-scaling on repeated calls
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const labels = Object.keys(state.valueBuckets);
  const values = labels.map(function (l) { return state.valueBuckets[l]; });
  const maxVal = Math.max(1, Math.max.apply(null, values));

  const padding = { top: 20, right: 16, bottom: 56, left: 40 };
  const chartW = cssWidth - padding.left - padding.right;
  const chartH = cssHeight - padding.top - padding.bottom;
  const barGap = 14;
  const barW = (chartW - barGap * (labels.length - 1)) / labels.length;

  // Gridlines
  ctx.strokeStyle = "#1f2b26";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartW, y);
    ctx.stroke();
  }

  // Bars
  labels.forEach(function (label, i) {
    const val = values[i];
    const barH = (val / maxVal) * chartH;
    const x = padding.left + i * (barW + barGap);
    const y = padding.top + chartH - barH;

    const isLast = i === labels.length - 1;
    ctx.fillStyle = isLast ? "#ffb454" : "#0ac18e";
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y, barW, barH);
    ctx.globalAlpha = 1;

    // Value label above bar
    if (val > 0) {
      ctx.fillStyle = "#e8f0ec";
      ctx.font = "600 11px JetBrains Mono, monospace";
      ctx.textAlign = "center";
      ctx.fillText(String(val), x + barW / 2, y - 6);
    }

    // X-axis label
    ctx.fillStyle = "#8fa39b";
    ctx.font = "500 10px JetBrains Mono, monospace";
    ctx.textAlign = "center";
    const parts = label.split(" ");
    ctx.fillText(parts.slice(0, 2).join(" "), x + barW / 2, padding.top + chartH + 16);
    if (parts.length > 2) {
      ctx.fillText(parts.slice(2).join(" "), x + barW / 2, padding.top + chartH + 30);
    }
  });

  // Legend (DOM, not canvas -- easier to keep accessible/selectable)
  const legend = document.getElementById("distLegend");
  legend.innerHTML =
    '<div class="chart-legend-item"><span class="chart-legend-swatch" style="background:#0ac18e"></span>Standard volume bucket</div>' +
    '<div class="chart-legend-item"><span class="chart-legend-swatch" style="background:#ffb454"></span>10,000+ BCH (whale-scale)</div>';
}

/* ----------------------------------------------------------
   RENDER: ACTIVITY LEADERBOARD
   ---------------------------------------------------------- */
function renderLeaderboard() {
  const body = document.getElementById("leaderboardBody");
  const entries = Array.from(state.addressActivity.values())
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, CONFIG.MAX_LEADERBOARD_ROWS);

  if (entries.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="table-loading">No activity scanned yet.</td></tr>';
    return;
  }

  body.innerHTML = entries.map(function (entry, idx) {
    const label = lookupAddressLabel(entry.address);
    return (
      "<tr>" +
        '<td class="rank-cell">#' + (idx + 1) + "</td>" +
        '<td class="addr-cell" title="' + escapeHtml(entry.address) + '">' + fmtAddrShort(entry.address) + "</td>" +
        '<td class="label-cell">' + (label ? escapeHtml(label.label) : '<span class="tiny-badge">Unlabeled</span>') + "</td>" +
        "<td>" + entry.count + "</td>" +
        "<td>" + fmtBch(satsToBch(entry.totalSats)) + "</td>" +
      "</tr>"
    );
  }).join("");
}

/* ----------------------------------------------------------
   RENDER: KNOWN MAJOR HOLDERS ("rich list", honestly scoped)
   ---------------------------------------------------------- */
async function renderRichList() {
  const body = document.getElementById("richListBody");

  if (KNOWN_ADDRESSES.length === 0) {
    body.innerHTML =
      '<tr><td colspan="6" class="table-loading">' +
      "No verified addresses configured yet. Add entries to data.js (KNOWN_ADDRESSES) " +
      "with addresses you've personally confirmed belong to an exchange or pool, and " +
      "their live balances will appear here." +
      "</td></tr>";
    return;
  }

  body.innerHTML = '<tr><td colspan="6" class="table-loading">Fetching live balances…</td></tr>';

  try {
    const results = await Promise.all(
      KNOWN_ADDRESSES.map(async function (entry) {
        try {
          const bal = await fetchAddressBalance(entry.address);
          return { entry: entry, balance: bal, ok: true };
        } catch (err) {
          return { entry: entry, ok: false };
        }
      })
    );

    const ranked = results
      .filter(function (r) { return r.ok; })
      .sort(function (a, b) { return b.balance.balanceSats - a.balance.balanceSats; });

    if (ranked.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="table-loading">Could not fetch balances right now. Try refreshing.</td></tr>';
      return;
    }

    body.innerHTML = ranked.map(function (r, idx) {
      const bch = satsToBch(r.balance.balanceSats);
      const usd = state.bchPriceUsd ? bch * state.bchPriceUsd : null;
      return (
        "<tr>" +
          '<td class="rank-cell">#' + (idx + 1) + "</td>" +
          '<td class="label-cell">' + escapeHtml(r.entry.label) + "</td>" +
          '<td class="addr-cell" title="' + escapeHtml(r.entry.address) + '">' + fmtAddrShort(r.entry.address) + "</td>" +
          "<td>" + fmtBch(bch) + "</td>" +
          "<td>" + (usd != null ? fmtUsd(usd) : "—") + "</td>" +
          '<td><span class="type-badge ' + r.entry.type + '">' + r.entry.type + "</span></td>" +
        "</tr>"
      );
    }).join("");
  } catch (err) {
    console.error("Rich list fetch failed:", err);
    body.innerHTML = '<tr><td colspan="6" class="table-loading">Could not fetch balances right now.</td></tr>';
  }
}

/* ----------------------------------------------------------
   RENDER: EXPORT BLOCK (BCHNostr-ready JSON)
   ---------------------------------------------------------- */
function renderExportBlock() {
  const pre = document.getElementById("exportBlock");
  if (state.whaleAlerts.length === 0) {
    pre.textContent = "// Whale alerts will appear here as they're detected.";
    return;
  }
  const latest = state.whaleAlerts[0];
  // Shaped as a generic structured event: a "kind"-style integer
  // tag plus a content string mirrors the Nostr event convention
  // (kind/content/tags) closely enough to drop into a relay
  // publisher or community bot without reshaping the payload.
  const nostrReady = {
    kind: 30078, // arbitrary application-specific kind, per NIP-78 convention
    content: buildAlertSentence(latest),
    tags: [
      ["t", "bch-whale-alert"],
      ["amount_bch", String(latest.valueBch)],
      ["amount_usd", String(Math.round(latest.valueUsd))],
      ["txid", latest.txid],
      ["from", latest.sender || "unresolved"],
      ["to", latest.recipient || "unresolved"]
    ],
    created_at: latest.time || Math.floor(Date.now() / 1000)
  };
  pre.textContent = JSON.stringify(nostrReady, null, 2);
}

function buildAlertSentence(alert) {
  const from = alert.senderLabel ? alert.senderLabel.label : fmtAddrShort(alert.sender);
  const to = alert.recipientLabel ? alert.recipientLabel.label : fmtAddrShort(alert.recipient);
  return (
    "\uD83D\uDC0B " + fmtBch(alert.valueBch) + " (" + fmtUsd(alert.valueUsd) + ") moved " +
    "from " + from + " to " + to + ". txid " + alert.txid.slice(0, 12) + "\u2026"
  );
}

/* ----------------------------------------------------------
   ADDRESS SEARCH
   ---------------------------------------------------------- */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function handleAddressSearch(rawAddress) {
  const resultEl = document.getElementById("searchResult");
  const btn = document.getElementById("searchBtn");
  const address = rawAddress.trim();

  if (!address) return;

  resultEl.hidden = false;
  resultEl.className = "search-result";
  resultEl.innerHTML = '<p class="table-loading">Looking up address…</p>';
  btn.disabled = true;
  btn.textContent = "Looking up…";

  try {
    const results = await Promise.all([
      fetchAddressBalance(address),
      fetchAddressTransactions(address, 15)
    ]);
    const balance = results[0];
    const txs = results[1];

    const label = lookupAddressLabel(address);
    const bch = satsToBch(balance.balanceSats);
    const usd = state.bchPriceUsd ? bch * state.bchPriceUsd : null;

    const txRowsHtml = txs.map(function (tx) {
      const isIncoming = (tx.outputs || []).some(function (o) {
        return o.address && normalizeAddress(o.address) === normalizeAddress(address);
      });
      const dirClass = isIncoming ? "dir-in" : "dir-out";
      const dirLabel = isIncoming ? "IN " : "OUT";
      const value = satsToBch(totalOutputSats(tx));
      return (
        '<div class="addr-tx-row">' +
          '<span class="' + dirClass + '">' + dirLabel + "</span>" +
          '<span>' + tx.txid.slice(0, 16) + "…</span>" +
          '<span>' + fmtBch(value) + "</span>" +
          '<span>' + fmtTimeAgo(tx.time) + "</span>" +
        "</div>"
      );
    }).join("") || '<p class="table-loading">No transactions found for this address.</p>';

    resultEl.innerHTML =
      (label ? '<span class="addr-label-badge">' + escapeHtml(label.label) + " · " + label.type + "</span><br>" : "") +
      '<div class="addr-summary">' +
        '<div class="addr-summary-item"><span class="addr-summary-label">Balance</span><span class="addr-summary-value">' + fmtBch(bch) + "</span></div>" +
        '<div class="addr-summary-item"><span class="addr-summary-label">Balance (USD)</span><span class="addr-summary-value">' + (usd != null ? fmtUsd(usd) : "—") + "</span></div>" +
        '<div class="addr-summary-item"><span class="addr-summary-label">Total received</span><span class="addr-summary-value">' + fmtBch(satsToBch(balance.receivedSats)) + "</span></div>" +
        '<div class="addr-summary-item"><span class="addr-summary-label">Total sent</span><span class="addr-summary-value">' + fmtBch(satsToBch(balance.sentSats)) + "</span></div>" +
        '<div class="addr-summary-item"><span class="addr-summary-label">Tx count</span><span class="addr-summary-value">' + balance.txCount.toLocaleString() + "</span></div>" +
        '<div class="addr-summary-item"><span class="addr-summary-label">Open UTXOs</span><span class="addr-summary-value">' + balance.utxoCount.toLocaleString() + "</span></div>" +
      "</div>" +
      '<p class="addr-summary-label" style="margin-bottom:8px;">Recent transactions</p>' +
      '<div class="addr-tx-list">' + txRowsHtml + "</div>";
  } catch (err) {
    console.error("Address search failed:", err);
    resultEl.className = "search-result is-error";
    resultEl.innerHTML =
      "Could not find or fetch that address. Double-check the format " +
      "(CashAddr, with or without the bitcoincash: prefix) and try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Look up";
  }
}

/* ----------------------------------------------------------
   COPY EXPORT BUTTON
   ---------------------------------------------------------- */
function setupCopyButton() {
  const btn = document.getElementById("copyExportBtn");
  btn.addEventListener("click", async function () {
    const text = document.getElementById("exportBlock").textContent;
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = original; }, 1500);
    } catch (err) {
      console.error("Clipboard write failed:", err);
    }
  });
}

/* ----------------------------------------------------------
   FULL REFRESH CYCLE
   ---------------------------------------------------------- */
async function runFullRefresh() {
  await refreshPrice();
  const best = await refreshNetworkStats();
  await scanRecentBlocks(best.height, best.hash);
  // Rich list balances refresh independently; price is set by now
  // so the USD column has data to work with.
  renderRichList();
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(runFullRefresh, CONFIG.REFRESH_INTERVAL_MS);
}

/* ----------------------------------------------------------
   INIT
   ---------------------------------------------------------- */
function init() {
  document.getElementById("searchForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const value = document.getElementById("searchInput").value;
    handleAddressSearch(value);
  });

  setupCopyButton();

  renderDistributionChart(); // draw an empty chart shell immediately
  window.addEventListener("resize", debounce(renderDistributionChart, 200));

  runFullRefresh();
  scheduleAutoRefresh();
}

/** Small debounce helper so window resize doesn't redraw the canvas constantly. */
function debounce(fn, wait) {
  let t;
  return function () {
    clearTimeout(t);
    const args = arguments;
    t = setTimeout(function () { fn.apply(null, args); }, wait);
  };
}

document.addEventListener("DOMContentLoaded", init);
