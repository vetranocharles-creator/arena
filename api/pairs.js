'use strict';
/**
 * GET /api/pairs
 * Returns up to 8 real Solana coins to seed a tournament season.
 * Never invents coins: if fewer than 8 qualify, `ready` is false and `found` says how many did.
 */
const dex = require('./_dex.js');

/* ---------- Season filters: edit these to change which coins qualify ---------- */
const FILTERS = {
  PUMPFUN_ONLY: true, // mint ends in "pump", or the pair trades on pumpfun / pumpswap
  MIN_MARKET_CAP_USD: 10000,
  MIN_LIQUIDITY_USD: 5000,
  MIN_AGE_MINUTES: 10,
  MAX_AGE_HOURS: 24,
  MIN_H1_TXNS: 30,
  MIN_H1_VOLUME_USD: 5000,
  REQUIRE_M5_BUYS_GT_SELLS: false,
};

const SEASON_SIZE = 8;
const MAX_CANDIDATES = 90; // 3 DexScreener lookups of 30
const SAFETY_BUDGET_MS = 5000;
const SEASON_TTL_MS = 15000;

const round2 = (n) => Math.round(n * 100) / 100;

function safetyEnabled() {
  return !/^(0|off|false|no)$/i.test(process.env.SAFETY_CHECKS || '');
}

async function buildSeason() {
  const { tokens, stale: discoveryStale } = await dex.discoverTokens();
  const candidates = tokens.slice(0, MAX_CANDIDATES);
  const meta = new Map(candidates.map((t) => [t.address, t]));
  const { pairs, stale: pairsStale } = await dex.fetchBestPairs(candidates.map((t) => t.address));

  const rejectedBy = {};
  const qualified = [];
  for (const [address, pair] of pairs) {
    const coin = dex.normalizePair(pair, meta.get(address));
    const reasons = dex.checkFilters(coin, FILTERS);
    if (reasons.length) {
      for (const r of reasons) rejectedBy[r] = (rejectedBy[r] || 0) + 1;
      continue;
    }
    coin.traction = round2(dex.traction(coin));
    qualified.push(coin);
  }
  qualified.sort((a, b) => b.traction - a.traction);

  let coins;
  let safety;
  if (safetyEnabled()) {
    const result = await dex.applySafetyChecks(qualified, {
      want: SEASON_SIZE,
      rpcUrl: process.env.SOLANA_RPC_URL || dex.PUBLIC_RPC_URL,
      budgetMs: SAFETY_BUDGET_MS,
    });
    coins = result.accepted;
    safety = {
      enabled: true,
      checked: result.checked,
      skipped: result.skipped,
      rejected: result.rejected,
      rateLimited: result.rateLimited,
      budgetExceeded: result.budgetExceeded,
    };
  } else {
    coins = qualified.slice(0, SEASON_SIZE).map((c) => ({ ...c, safety: { status: 'off' } }));
    safety = { enabled: false };
  }

  return {
    ready: coins.length >= SEASON_SIZE,
    found: coins.length,
    needed: SEASON_SIZE,
    coins,
    stale: Boolean(discoveryStale || pairsStale),
    discovered: tokens.length,
    scanned: pairs.size,
    qualified: qualified.length,
    rejectedBy,
    safety,
    filters: FILTERS,
    generatedAt: new Date(dex.now()).toISOString(),
  };
}

async function handler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    return dex.sendJson(res, 405, { ok: false, error: 'Use GET.' }, 'no-store');
  }
  try {
    const { value, stale } = await dex.cached('season', SEASON_TTL_MS, buildSeason, (v) => !v.stale);
    return dex.sendJson(
      res,
      200,
      { ok: true, ...value, stale: Boolean(value.stale || stale) },
      'public, max-age=0, s-maxage=15, stale-while-revalidate=300'
    );
  } catch (err) {
    return dex.sendJson(
      res,
      502,
      {
        ok: false,
        error: 'Market data is unavailable right now.',
        detail: err.message,
        ready: false,
        found: 0,
        needed: SEASON_SIZE,
        coins: [],
      },
      'no-store'
    );
  }
}

module.exports = handler;
module.exports.FILTERS = FILTERS;
module.exports.SEASON_SIZE = SEASON_SIZE;
module.exports.buildSeason = buildSeason;
