'use strict';

// Shared helpers for /api routes. Files starting with "_" are not exposed as routes on Vercel.

const DEX_BASE = 'https://api.dexscreener.com';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

const TTL = {
  DISCOVERY_MS: 60 * 1000, // discovery endpoints: 60 req/min limit
  PAIRS_MS: 15 * 1000,     // pair data: 300 req/min limit
  STALE_MAX_MS: 5 * 60 * 1000, // serve stale data this long if DexScreener is down
};

const MAX_TOKENS_PER_CALL = 30;
const DISCOVERY_PATHS = [
  '/token-profiles/latest/v1',
  '/token-boosts/latest/v1',
  '/token-boosts/top/v1',
];

// Token accounts owned by these programs/authorities are liquidity pools, not holders.
const KNOWN_POOL_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4 authority
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM authority
]);

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isValidSolanaAddress = (s) => typeof s === 'string' && BASE58_RE.test(s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fetch with timeout + retry ----------

async function fetchJson(url, { retries = 2, timeoutMs = 6000, init = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: { accept: 'application/json', ...(init.headers || {}) },
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      const retryable = e.retryable !== false; // network errors and timeouts are retryable
      if (!retryable || attempt === retries) break;
      await sleep(300 * 2 ** attempt + Math.random() * 200);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---------- in-memory cache (per warm serverless instance) ----------

const cache = new Map();

async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.hasValue && now - entry.at < ttlMs) return entry.value;
  if (entry && entry.pending) return entry.pending;

  const pending = (async () => {
    try {
      const value = await loader();
      cache.set(key, { hasValue: true, value, at: Date.now() });
      return value;
    } catch (e) {
      if (entry && entry.hasValue && Date.now() - entry.at < TTL.STALE_MAX_MS) {
        cache.set(key, { hasValue: true, value: entry.value, at: entry.at });
        return entry.value; // stale but usable
      }
      cache.delete(key);
      throw e;
    }
  })();

  cache.set(key, { ...(entry || {}), pending });
  if (cache.size > 500) {
    for (const k of cache.keys()) { cache.delete(k); if (cache.size <= 400) break; }
  }
  return pending;
}

function clearCache() { cache.clear(); }

// ---------- DexScreener calls ----------

function asList(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.pairs)) return v.pairs;
  if (v && Array.isArray(v.data)) return v.data;
  return [];
}

async function getDiscoveredSolanaTokens() {
  const results = await Promise.allSettled(
    DISCOVERY_PATHS.map((p) => cached(`disc:${p}`, TTL.DISCOVERY_MS, () => fetchJson(DEX_BASE + p)))
  );
  const seen = new Map();
  let ok = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    ok++;
    for (const it of asList(r.value)) {
      if (!it || it.chainId !== 'solana' || !isValidSolanaAddress(it.tokenAddress)) continue;
      if (!seen.has(it.tokenAddress)) {
        seen.set(it.tokenAddress, {
          tokenAddress: it.tokenAddress,
          icon: typeof it.icon === 'string' ? it.icon : null,
          url: it.url || null,
        });
      }
    }
  }
  if (!ok) throw new Error('All DexScreener discovery endpoints failed');
  return [...seen.values()];
}

async function getPairsForTokens(addresses) {
  const unique = [...new Set(addresses)].filter(isValidSolanaAddress);
  const chunks = [];
  for (let i = 0; i < unique.length; i += MAX_TOKENS_PER_CALL) chunks.push(unique.slice(i, i + MAX_TOKENS_PER_CALL));
  const results = await Promise.allSettled(
    chunks.map((chunk) => {
      const key = `pairs:${[...chunk].sort().join(',')}`;
      return cached(key, TTL.PAIRS_MS, () => fetchJson(`${DEX_BASE}/tokens/v1/solana/${chunk.join(',')}`));
    })
  );
  const pairs = [];
  let ok = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    ok++;
    pairs.push(...asList(r.value));
  }
  if (chunks.length && !ok) throw new Error('DexScreener pair lookup failed');
  return pairs;
}

// ---------- normalisation ----------

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
const num = (v) => numOrNull(v) ?? 0;

const cleanText = (s, max) =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

// One token can have several pairs: keep the one with the most USD liquidity.
function bestPairByToken(pairs) {
  const best = new Map();
  for (const p of pairs) {
    if (!p || p.chainId && p.chainId !== 'solana') continue;
    const addr = p.baseToken && p.baseToken.address;
    if (!isValidSolanaAddress(addr)) continue;
    const cur = best.get(addr);
    if (!cur || num(p.liquidity && p.liquidity.usd) > num(cur.liquidity && cur.liquidity.usd)) best.set(addr, p);
  }
  return best;
}

function normalizePair(p, now = Date.now()) {
  const tx = (k) => ({
    buys: num(p.txns && p.txns[k] && p.txns[k].buys),
    sells: num(p.txns && p.txns[k] && p.txns[k].sells),
  });
  const win = (obj) => ({
    m5: num(obj && obj.m5), h1: num(obj && obj.h1), h6: num(obj && obj.h6), h24: num(obj && obj.h24),
  });
  const created = numOrNull(p.pairCreatedAt);
  const image = p.info && typeof p.info.imageUrl === 'string' && p.info.imageUrl.startsWith('https://')
    ? p.info.imageUrl : null;
  const pairAddress = p.pairAddress || null;
  return {
    address: p.baseToken.address,
    pairAddress,
    name: cleanText(p.baseToken.name, 40) || 'Unknown',
    symbol: cleanText(p.baseToken.symbol, 14) || '???',
    imageUrl: image,
    dexId: p.dexId || null,
    quoteSymbol: (p.quoteToken && p.quoteToken.symbol) || null,
    priceUsd: num(p.priceUsd),
    priceNative: num(p.priceNative),
    marketCap: numOrNull(p.marketCap) ?? numOrNull(p.fdv) ?? 0,
    liquidityUsd: num(p.liquidity && p.liquidity.usd),
    volume: win(p.volume),
    priceChange: win(p.priceChange),
    txns: { m5: tx('m5'), h1: tx('h1'), h6: tx('h6'), h24: tx('h24') },
    ageMinutes: created ? Math.max(0, (now - created) / 60000) : null,
    boosted: num(p.boosts && p.boosts.active) > 0,
    dexscreenerUrl: typeof p.url === 'string' && p.url.startsWith('https://')
      ? p.url : `https://dexscreener.com/solana/${pairAddress || p.baseToken.address}`,
  };
}

// ---------- filters + scoring ----------

// pump.fun mints end in "pump"; pairs trade on the bonding curve (pumpfun) or PumpSwap after graduation.
const PUMP_DEX_IDS = new Set(['pumpfun', 'pumpswap']);
function isPumpFun(t) {
  return (typeof t.address === 'string' && t.address.endsWith('pump')) || PUMP_DEX_IDS.has(t.dexId);
}

function checkFilters(t, f) {
  const reasons = [];
  if (f.PUMPFUN_ONLY && !isPumpFun(t)) reasons.push('notPumpFun');
  if (t.marketCap < f.MIN_MARKET_CAP_USD) reasons.push('marketCap');
  if (t.liquidityUsd < f.MIN_LIQUIDITY_USD) reasons.push('liquidity');
  if (t.ageMinutes === null || t.ageMinutes < f.MIN_AGE_MINUTES || t.ageMinutes > f.MAX_AGE_MINUTES) reasons.push('age');
  if (f.REQUIRE_M5_BUYS_GT_SELLS && !(t.txns.m5.buys > t.txns.m5.sells)) reasons.push('m5Pressure');
  if (t.txns.h1.buys + t.txns.h1.sells < f.MIN_H1_TXNS) reasons.push('h1Txns');
  if (t.volume.h1 < f.MIN_H1_VOLUME_USD) reasons.push('h1Volume');
  return { ok: reasons.length === 0, reasons };
}

function tractionScore(t) {
  return (
    t.volume.h1 / 1000 +
    (t.txns.h1.buys - t.txns.h1.sells) * 0.5 +
    t.priceChange.h1 * 0.2 +
    (t.boosted ? 2 : 0)
  );
}

// SOL/USD derived from SOL-quoted pairs (priceUsd / priceNative), median of samples.
function estimateSolUsd(pairs, fallback = 150) {
  const samples = [];
  for (const p of pairs) {
    const q = p && p.quoteToken && p.quoteToken.symbol;
    if (q !== 'SOL' && q !== 'WSOL') continue;
    const usd = num(p.priceUsd), nat = num(p.priceNative);
    if (usd > 0 && nat > 0) samples.push(usd / nat);
  }
  if (!samples.length) return fallback;
  samples.sort((a, b) => a - b);
  const mid = samples[Math.floor(samples.length / 2)];
  return mid > 5 && mid < 5000 ? Math.round(mid * 100) / 100 : fallback;
}

function toPublicToken(t) {
  return {
    address: t.address,
    pairAddress: t.pairAddress,
    name: t.name,
    symbol: t.symbol,
    imageUrl: t.imageUrl,
    priceUsd: t.priceUsd,
    marketCap: t.marketCap,
    liquidityUsd: t.liquidityUsd,
    volume: t.volume,
    txns: t.txns,
    priceChange: t.priceChange,
    ageMinutes: t.ageMinutes === null ? null : Math.round(t.ageMinutes),
    dexscreenerUrl: t.dexscreenerUrl,
    boosted: t.boosted,
    ...(t.traction !== undefined ? { traction: Math.round(t.traction * 100) / 100 } : {}),
    ...(t.safety ? { safety: t.safety } : {}),
  };
}

// ---------- Solana RPC safety checks ----------

async function rpcCall(rpcUrl, method, params, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429) { const e = new Error('RPC rate limited'); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) {
      const e = new Error(`RPC error: ${json.error.message || json.error.code}`);
      e.rateLimited = json.error.code === 429 || json.error.code === -32429 || /rate|too many/i.test(json.error.message || '');
      throw e;
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function checkTokenSafety(token, { rpcUrl, maxTop10Share, deadline, state }) {
  if (state.down) return { status: 'skipped', reason: 'rpc unavailable' };
  const timeoutMs = () => Math.max(400, Math.min(3000, deadline - Date.now()));
  try {
    const info = await rpcCall(rpcUrl, 'getParsedAccountInfo', [token.address, { encoding: 'jsonParsed', commitment: 'confirmed' }], timeoutMs());
    const parsed = info && info.value && info.value.data && info.value.data.parsed && info.value.data.parsed.info;
    if (!parsed) return { status: 'skipped', reason: 'mint not parsed' };
    if (parsed.mintAuthority) return { status: 'rejected', reason: 'mint authority active' };
    if (parsed.freezeAuthority) return { status: 'rejected', reason: 'freeze authority active' };
    const supply = Number(parsed.supply);
    if (!(supply > 0)) return { status: 'skipped', reason: 'unknown supply' };

    const largest = await rpcCall(rpcUrl, 'getTokenLargestAccounts', [token.address, { commitment: 'confirmed' }], timeoutMs());
    const accounts = (largest && largest.value) || [];

    // Identify pool vaults by their owner (the pair itself, or a known AMM authority).
    const owners = {};
    try {
      const multi = await rpcCall(rpcUrl, 'getMultipleAccounts', [accounts.map((a) => a.address), { encoding: 'jsonParsed' }], timeoutMs());
      ((multi && multi.value) || []).forEach((acc, i) => {
        const o = acc && acc.data && acc.data.parsed && acc.data.parsed.info && acc.data.parsed.info.owner;
        if (o && accounts[i]) owners[accounts[i].address] = o;
      });
    } catch (e) {
      if (e.rateLimited) state.down = true;
    }

    let poolExcluded = 0;
    const holders = accounts.filter((a) => {
      const o = owners[a.address];
      const isPool = !!o && (o === token.pairAddress || KNOWN_POOL_AUTHORITIES.has(o));
      if (isPool) poolExcluded++;
      return !isPool;
    });
    const top10 = holders.slice(0, 10).reduce((s, a) => s + Number(a.amount || 0), 0);
    const share = top10 / supply;
    if (share > maxTop10Share) {
      return { status: 'rejected', reason: `top 10 hold ${(share * 100).toFixed(1)}%`, top10Share: round3(share) };
    }
    return { status: 'passed', top10Share: round3(share), poolExcluded };
  } catch (e) {
    if (e.rateLimited) state.down = true;
    return { status: 'skipped', reason: e.rateLimited ? 'rate limited' : 'rpc error' };
  }
}

const round3 = (x) => Math.round(x * 1000) / 1000;

// Walk candidates in traction order, in small parallel batches, until `want` pass or time runs out.
async function applySafetyChecks(list, { rpcUrl, maxTop10Share, budgetMs, want }) {
  const deadline = Date.now() + budgetMs;
  const state = { down: false };
  const accepted = [];
  const rejected = [];
  let idx = 0;
  while (accepted.length < want && idx < list.length) {
    if (Date.now() > deadline - 300 || state.down) {
      const reason = state.down ? 'rpc unavailable' : 'time budget';
      for (const t of list.slice(idx, idx + (want - accepted.length))) {
        accepted.push({ ...t, safety: { status: 'skipped', reason } });
      }
      break;
    }
    const batch = list.slice(idx, idx + 4);
    idx += batch.length;
    const results = await Promise.all(batch.map((t) => checkTokenSafety(t, { rpcUrl, maxTop10Share, deadline, state })));
    batch.forEach((t, i) => {
      if (results[i].status === 'rejected') rejected.push({ symbol: t.symbol, reason: results[i].reason });
      else if (accepted.length < want) accepted.push({ ...t, safety: results[i] });
    });
  }
  return { accepted, rejected };
}

// ---------- response helper ----------

function send(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheControl || 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = {
  DEX_BASE,
  DEFAULT_RPC_URL,
  TTL,
  fetchJson,
  cached,
  clearCache,
  getDiscoveredSolanaTokens,
  getPairsForTokens,
  bestPairByToken,
  normalizePair,
  checkFilters,
  tractionScore,
  isPumpFun,
  estimateSolUsd,
  toPublicToken,
  applySafetyChecks,
  checkTokenSafety,
  isValidSolanaAddress,
  send,
};
