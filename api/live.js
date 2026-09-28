'use strict';
/**
 * GET /api/live?addresses=a,b,c
 * Fresh data for the coins currently fighting (up to 30). The page polls this every 15s.
 */
const dex = require('./_dex.js');

const MAX_ADDRESSES = 30;

async function handler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    return dex.sendJson(res, 405, { ok: false, error: 'Use GET.' }, 'no-store');
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const requested = [
    ...new Set(
      (url.searchParams.get('addresses') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
  const addresses = requested.filter(dex.isAddress).slice(0, MAX_ADDRESSES);

  if (!addresses.length) {
    return dex.sendJson(
      res,
      400,
      { ok: false, error: `Pass ?addresses= with 1 to ${MAX_ADDRESSES} Solana token addresses.` },
      'no-store'
    );
  }

  try {
    const { pairs, stale } = await dex.fetchBestPairs(addresses);
    const coins = addresses.filter((a) => pairs.has(a)).map((a) => dex.normalizePair(pairs.get(a)));
    const missing = addresses.filter((a) => !pairs.has(a));
    return dex.sendJson(
      res,
      200,
      { ok: true, coins, missing, stale, generatedAt: new Date(dex.now()).toISOString() },
      'public, max-age=0, s-maxage=10, stale-while-revalidate=60'
    );
  } catch (err) {
    return dex.sendJson(
      res,
      502,
      { ok: false, error: 'Live market data is unavailable right now.', detail: err.message, coins: [] },
      'no-store'
    );
  }
}

module.exports = handler;
