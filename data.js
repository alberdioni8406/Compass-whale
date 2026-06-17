/* ============================================================
   data.js
   Curated, publicly-documented BCH address labels.

   IMPORTANT — HONESTY NOTE FOR WHOEVER MAINTAINS THIS:
   There is no free API that returns a true "BCH rich list."
   Building one for real means indexing every address that has
   ever received BCH (millions of them) and sorting by balance —
   that's a multi-day server-side indexing job, not something a
   static frontend can do client-side on every page load.

   What we CAN do honestly:
   1. Maintain a small list of addresses that are publicly known
      to belong to exchanges or mining pools (because they've been
      documented by the community, block explorers, or the
      entities themselves disclosing deposit/cold-storage addresses).
   2. Fetch their REAL, LIVE balance from the chain every refresh.
   3. Be upfront in the UI that this is "known major holders," not
      an exhaustive rich list.

   This file is intentionally separate from api.js / app.js so you
   can add, remove, or correct labels without touching any logic.
   If you maintain this app, verify and refresh this list
   periodically — labels can go stale if an exchange rotates cold
   storage. Swap in your own verified addresses freely.
   ============================================================ */

// Known address book: exchange / mining-pool wallets.
// type: 'exchange' | 'pool' | 'unknown'
//
// HONEST STARTING STATE: this array ships EMPTY. I'm not going to
// fabricate addresses and label them "Binance" or "ViaBTC" just to
// make the table look populated — every address below should be one
// you've personally verified (e.g. an exchange's published deposit
// address, a mining pool's documented payout address you can see
// paying out blocks on a block explorer, or one of your own
// CashCompass/CompassPay/StableShift project wallets).
//
// To add one:
//   { address: "bitcoincash:q...", label: "Name + what it is", type: "exchange" }
//
// Until you add entries, the "Known major holders" panel will show
// real, live balance data for zero addresses and say so plainly —
// that's correct behavior, not a bug. An honest empty state beats a
// confident wrong one.
const KNOWN_ADDRESSES = [
  // Add your verified addresses here.
];

// Quick lookup map, built once at load time, used by the whale
// detector and address search to label any matching address
// instantly (O(1) instead of scanning the array every time).
const KNOWN_ADDRESS_MAP = new Map(
  KNOWN_ADDRESSES.map(entry => [normalizeAddress(entry.address), entry])
);

// Normalizes a CashAddr so lookups are consistent regardless of
// whether the "bitcoincash:" prefix is present or absent, or the
// casing differs. Haskoin returns addresses WITH the prefix.
function normalizeAddress(addr) {
  if (!addr) return "";
  return addr.trim().toLowerCase().replace(/^bitcoincash:/, "");
}

// Looks up a label for any address, prefix or no prefix.
// Returns null if the address isn't in our known book.
function lookupAddressLabel(addr) {
  const found = KNOWN_ADDRESS_MAP.get(normalizeAddress(addr));
  return found || null;
}
