'use strict';

// GET /api/pairs  ->  seeds a tournament season with up to 8 real Solana pairs getting traction.

// ---- Configurable filters ----
const FILTERS = {
  PUMPFUN_ONLY: true,             // only coins launched on pump.fun (set to false to allow any Solana coin)
  MIN_MARKET_CAP_USD: 10000,      // marketCap, or fdv when marketCap is null
  MIN_LIQUIDITY_USD: 5000,
  MIN_AGE_MINUTES: 10,
  MAX_AGE_MINUTES: 24 * 60,
  REQUIRE_M5_BUYS_GT_SELLS: false,
  MIN_H1_TXNS: 30,                // buys + sells in the last hour
  MIN_H1_VOLUME_USD: 5000,
};

// ---- Optional on-chain safety checks (SOLANA_RPC_URL, else the public mainnet RPC) ----
const SAFETY = {
  ENABLED: true,
  MAX_TOP10_SHARE: 0.35,          // reject if the top 10 holders (pool excluded when identifiable) own more
  TIME_BUDGET_MS: 5000,           // stay well inside serverless time limits
};

const BRACKET_SIZE = 8;
const SEASON_CACHE_MS = 60 * 1000;

const dex = require('./_dex');

async function buildSeason() {
  const now = Date.now();
  const discovered = await dex.getDiscoveredSolanaTokens();
  const iconByAddr = new Map(discovered.map((d) => [d.tokenAddress, d.icon]));
  const pairs = await dex.getPairsForTokens(discovered.map((d) => d.tokenAddress));
  const solUsd = dex.estimateSolUsd(pairs);
  const best = dex.bestPairByToken(pairs);

  const candidates = [];
  for (const [addr, pair] of best) {
    if (!iconByAddr.has(addr)) continue; // only tokens we discovered
    const t = dex.normalizePair(pair, now);
    if (!t.imageUrl) {
      const icon = iconByAddr.get(addr);
      if (icon && icon.startsWith('https://')) t.imageUrl = icon;
    }
    candidates.push(t);
  }

  const passing = candidates
    .filter((t) => dex.checkFilters(t, FILTERS).ok)
    .map((t) => ({ ...t, traction: dex.tractionScore(t) }))
    .sort((a, b) => b.traction - a.traction);

  let selected;
  let safetyRejected = [];
  if (SAFETY.ENABLED && passing.length) {
    const { accepted, rejected } = await dex.applySafetyChecks(passing, {
      rpcUrl: process.env.SOLANA_RPC_URL || dex.DEFAULT_RPC_URL,
      maxTop10Share: SAFETY.MAX_TOP10_SHARE,
      budgetMs: SAFETY.TIME_BUDGET_MS,
      want: BRACKET_SIZE,
    });
    selected = accepted;
    safetyRejected = rejected;
  } else {
    selected = passing.slice(0, BRACKET_SIZE);
  }

  return {
    mode: 'live',
    fetchedAt: now,
    solUsd,
    tokens: selected.map(dex.toPublicToken),
    stats: {
      discovered: discovered.length,
      withPairs: candidates.length,
      passedFilters: passing.length,
      safetyRejected,
    },
    filters: FILTERS,
  };
}

async function handler(req, res) {
  try {
    const body = await dex.cached('season', SEASON_CACHE_MS, buildSeason);
    dex.send(res, 200, body, 's-maxage=60, stale-while-revalidate=30');
  } catch (e) {
    // 200 with an empty list: the front end fills the bracket with simulated coins.
    dex.send(res, 200, { mode: 'unavailable', error: 'Live data unavailable', detail: String(e.message || e), tokens: [] }, 'no-store');
  }
}

module.exports = handler;
module.exports.buildSeason = buildSeason;
module.exports.FILTERS = FILTERS;
module.exports.SAFETY = SAFETY;
