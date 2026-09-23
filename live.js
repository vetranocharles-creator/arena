'use strict';

// GET /api/live?addresses=a,b,c  ->  latest pair data for tokens in play. One DexScreener call, cached 15s.

const dex = require('./_dex');

async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const raw = url.searchParams.get('addresses') || '';
  const addresses = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
    .filter(dex.isValidSolanaAddress)
    .slice(0, 30);

  if (!addresses.length) {
    return dex.send(res, 400, { error: 'Pass ?addresses= with 1 to 30 Solana token addresses.' });
  }

  try {
    const pairs = await dex.getPairsForTokens(addresses);
    const best = dex.bestPairByToken(pairs);
    const now = Date.now();
    const tokens = {};
    const missing = [];
    for (const addr of addresses) {
      const p = best.get(addr);
      if (p) tokens[addr] = dex.toPublicToken(dex.normalizePair(p, now));
      else missing.push(addr);
    }
    dex.send(res, 200, { fetchedAt: now, solUsd: dex.estimateSolUsd(pairs), tokens, missing }, 's-maxage=15, stale-while-revalidate=15');
  } catch (e) {
    dex.send(res, 502, { error: 'Live data unavailable', detail: String(e.message || e), tokens: {} });
  }
}

module.exports = handler;
