'use strict';
/**
 * Shared helpers for the Arena API routes.
 * The leading underscore in the file name keeps Vercel from turning this file into a route.
 *
 *   fetchJson          fetch with timeout and retry
 *   cached             in-memory cache with stale fallback
 *   discoverTokens     latest Solana tokens from DexScreener profiles and boosts
 *   fetchBestPairs     pair data, keeping the most liquid pair per token
 *   normalizePair      turns a DexScreener pair into the coin shape the page uses
 *   checkFilters       season filters
 *   traction           ranking score
 *   applySafetyChecks  optional on-chain checks through Solana RPC
 */

const DEX_BASE = 'https://api.dexscreener.com';
const PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const DISCOVERY_TTL_MS = 60 * 1000;
const PAIR_TTL_MS = 15 * 1000;
const STALE_MAX_MS = 5 * 60 * 1000;
const MAX_ADDRESSES_PER_LOOKUP = 30;

const DISCOVERY_ENDPOINTS = [
  { path: '/token-profiles/latest/v1', boosted: false },
  { path: '/token-boosts/latest/v1', boosted: true },
  { path: '/token-boosts/top/v1', boosted: true },
];

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ---------- clock and cache (overridable in tests) ---------- */

let clock = () => Date.now();
let retryDelayMs = 300;
const cache = new Map();
const inflight = new Map();
const pairCache = new Map();

function now() {
  return clock();
}
function _setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}
function _setRetryDelay(ms) {
  retryDelayMs = ms;
}
function _resetCache() {
  cache.clear();
  inflight.clear();
  pairCache.clear();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- fetch with timeout and retry ---------- */

class HttpError extends Error {
  constructor(status, url) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch (_) {
      /* keep raw url */
    }
    super(`HTTP ${status} from ${host}`);
    this.status = status;
  }
}

/**
 * GET or POST JSON. Retries timeouts, network errors, 429 and 5xx responses.
 * Other 4xx responses fail straight away.
 */
async function fetchJson(url, { timeoutMs = 4000, retries = 2, init = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers || {}) },
        signal: controller.signal,
      });
      if (res.ok) return await res.json();
      const err = new HttpError(res.status, url);
      if (res.status !== 429 && res.status < 500) err.fatal = true;
      throw err;
    } catch (err) {
      if (err.fatal) throw err;
      lastError =
        err.name === 'AbortError'
          ? Object.assign(new Error(`Timed out after ${timeoutMs}ms`), { timeout: true })
          : err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries && retryDelayMs > 0) await sleep(retryDelayMs * 2 ** attempt);
  }
  throw lastError;
}

/**
 * Returns { value, stale }. Serves the cached value while fresh. If the loader
 * fails, serves the last good value for up to 5 minutes, then gives up.
 * Values built from stale inputs are returned but not stored, so the 5 minute
 * limit always counts from the last truly fresh data.
 */
async function cached(key, ttlMs, loader, shouldCache = () => true) {
  const hit = cache.get(key);
  const started = now();
  if (hit && started - hit.ts < ttlMs) return { value: hit.value, stale: false };
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const value = await loader();
      if (shouldCache(value)) cache.set(key, { value, ts: now() });
      return { value, stale: false };
    } catch (err) {
      if (hit && started - hit.ts < STALE_MAX_MS) {
        return { value: hit.value, stale: true, error: err.message };
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/* ---------- DexScreener ---------- */

function isAddress(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

/** Latest Solana tokens from profiles and boosts. Cached for 60s. */
async function discoverTokens() {
  const { value, stale } = await cached('discovery', DISCOVERY_TTL_MS, async () => {
    const results = await Promise.allSettled(
      DISCOVERY_ENDPOINTS.map((e) => fetchJson(DEX_BASE + e.path))
    );
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;

    const byAddress = new Map();
    results.forEach((result, i) => {
      if (result.status !== 'fulfilled' || !Array.isArray(result.value)) return;
      for (const item of result.value) {
        if (!item || item.chainId !== 'solana' || !isAddress(item.tokenAddress)) continue;
        const entry = byAddress.get(item.tokenAddress) || {
          address: item.tokenAddress,
          boosted: false,
          icon: null,
        };
        if (DISCOVERY_ENDPOINTS[i].boosted) entry.boosted = true;
        if (!entry.icon && typeof item.icon === 'string') entry.icon = item.icon;
        byAddress.set(item.tokenAddress, entry);
      }
    });
    return [...byAddress.values()];
  });
  return { tokens: value, stale };
}

/** For each requested token, keep the Solana pair with the most USD liquidity. */
function pickBestPairs(pairs, addresses) {
  const wanted = new Set(addresses);
  const best = new Map();
  for (const pair of pairs) {
    if (!pair || pair.chainId !== 'solana') continue;
    const address = pair.baseToken && pair.baseToken.address;
    if (!wanted.has(address)) continue;
    const liquidity = Number(pair.liquidity && pair.liquidity.usd) || 0;
    const current = best.get(address);
    const currentLiquidity = current ? Number(current.liquidity && current.liquidity.usd) || 0 : -1;
    if (liquidity > currentLiquidity) best.set(address, pair);
  }
  return best;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Pair lookup for many tokens, 30 per request. Each token is cached for 15s.
 * If DexScreener fails, tokens fall back to data up to 5 minutes old.
 * Returns { pairs: Map(address -> raw pair), stale }.
 */
async function fetchBestPairs(addresses) {
  const list = [...new Set(addresses.filter(isAddress))];
  const started = now();
  const pairs = new Map();
  const toFetch = [];
  let stale = false;

  for (const address of list) {
    const hit = pairCache.get(address);
    if (hit && started - hit.ts < PAIR_TTL_MS) {
      if (hit.pair) pairs.set(address, hit.pair);
    } else {
      toFetch.push(address);
    }
  }

  const errors = [];
  await Promise.all(
    chunk(toFetch, MAX_ADDRESSES_PER_LOOKUP).map(async (group) => {
      try {
        const data = await fetchJson(`${DEX_BASE}/tokens/v1/solana/${group.join(',')}`);
        const best = pickBestPairs(Array.isArray(data) ? data : [], group);
        const fetchedAt = now();
        for (const address of group) {
          const pair = best.get(address) || null;
          pairCache.set(address, { pair, ts: fetchedAt });
          if (pair) pairs.set(address, pair);
        }
      } catch (err) {
        errors.push(err);
        for (const address of group) {
          const hit = pairCache.get(address);
          if (hit && hit.pair && started - hit.ts < STALE_MAX_MS) {
            pairs.set(address, hit.pair);
            stale = true;
          }
        }
      }
    })
  );

  if (errors.length && pairs.size === 0 && list.length) throw errors[0];
  return { pairs, stale };
}

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const safeHttps = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
const safeDexUrl = (u) =>
  typeof u === 'string' && /^https:\/\/dexscreener\.com\//i.test(u) ? u : null;

/** The coin shape the page uses. */
function normalizePair(pair, meta = {}) {
  const txns = pair.txns || {};
  const volume = pair.volume || {};
  const change = pair.priceChange || {};
  const createdAt = num(pair.pairCreatedAt) || null;
  const windowStats = (key) => ({
    buys: num(txns[key] && txns[key].buys),
    sells: num(txns[key] && txns[key].sells),
    volume: num(volume[key]),
    change: num(change[key]),
  });
  return {
    address: pair.baseToken.address,
    pairAddress: pair.pairAddress || null,
    name: String(pair.baseToken.name || '').slice(0, 40),
    symbol: String(pair.baseToken.symbol || '').slice(0, 16),
    image: safeHttps(pair.info && pair.info.imageUrl) || safeHttps(meta.icon) || null,
    url:
      safeDexUrl(pair.url) ||
      (pair.pairAddress ? `https://dexscreener.com/solana/${pair.pairAddress}` : null),
    dexId: pair.dexId || '',
    priceUsd: num(pair.priceUsd),
    marketCap: num(pair.marketCap != null ? pair.marketCap : pair.fdv),
    liquidityUsd: num(pair.liquidity && pair.liquidity.usd),
    pairCreatedAt: createdAt,
    ageMinutes: createdAt ? Math.round(((now() - createdAt) / 60000) * 10) / 10 : null,
    m5: windowStats('m5'),
    h1: windowStats('h1'),
    boosted: Boolean(meta.boosted) || num(pair.boosts && pair.boosts.active) > 0,
  };
}

/* ---------- filters and scoring ---------- */

function isPumpfun(coin) {
  return (
    (typeof coin.address === 'string' && coin.address.endsWith('pump')) ||
    coin.dexId === 'pumpfun' ||
    coin.dexId === 'pumpswap'
  );
}

/** Returns the reasons a coin fails. An empty list means it qualifies. */
function checkFilters(coin, f) {
  const reasons = [];
  if (f.PUMPFUN_ONLY && !isPumpfun(coin)) reasons.push('not_pumpfun');
  if (coin.marketCap < f.MIN_MARKET_CAP_USD) reasons.push('market_cap');
  if (coin.liquidityUsd < f.MIN_LIQUIDITY_USD) reasons.push('liquidity');
  if (
    coin.ageMinutes == null ||
    coin.ageMinutes < f.MIN_AGE_MINUTES ||
    coin.ageMinutes > f.MAX_AGE_HOURS * 60
  ) {
    reasons.push('age');
  }
  if (coin.h1.buys + coin.h1.sells < f.MIN_H1_TXNS) reasons.push('h1_txns');
  if (coin.h1.volume < f.MIN_H1_VOLUME_USD) reasons.push('h1_volume');
  if (f.REQUIRE_M5_BUYS_GT_SELLS && !(coin.m5.buys > coin.m5.sells)) reasons.push('m5_pressure');
  return reasons;
}

/** traction = h1 volume/1000 + (h1 buys - h1 sells)*0.5 + h1 change*0.2 + 2 if boosted */
function traction(coin) {
  return (
    coin.h1.volume / 1000 +
    (coin.h1.buys - coin.h1.sells) * 0.5 +
    coin.h1.change * 0.2 +
    (coin.boosted ? 2 : 0)
  );
}

/* ---------- optional safety checks through Solana RPC ---------- */

class RateLimited extends Error {}
class BudgetExceeded extends Error {}

async function rpc(url, method, params, deadline) {
  const remaining = deadline - now();
  if (remaining < 100) throw new BudgetExceeded('Safety check time budget used up');
  let body;
  try {
    body = await fetchJson(url, {
      retries: 0,
      timeoutMs: Math.min(remaining, 2500),
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      },
    });
  } catch (err) {
    if (err.status === 429) throw new RateLimited('RPC rate limited');
    if (err.timeout) throw new BudgetExceeded(err.message);
    throw err;
  }
  if (body && body.error) {
    const code = body.error.code;
    if (code === 429 || code === -32429 || /rate|too many/i.test(body.error.message || '')) {
      throw new RateLimited('RPC rate limited');
    }
    throw new Error(`RPC error: ${body.error.message || code}`);
  }
  return body && body.result;
}

/**
 * Rejects coins with an active mint or freeze authority, or where the 10 largest
 * non-pool holders own more than 35% of supply. A holder counts as a pool when its
 * token account or owner is the pair address, or when the owner is itself owned by
 * a program (pools and bonding curves) rather than being a normal wallet.
 */
async function checkToken(coin, rpcUrl, deadline, maxTop10 = 0.35) {
  const mint = await rpc(rpcUrl, 'getAccountInfo', [coin.address, { encoding: 'jsonParsed' }], deadline);
  const info =
    mint && mint.value && mint.value.data && mint.value.data.parsed && mint.value.data.parsed.info;
  if (!info) throw new Error('Mint account not readable');
  if (info.mintAuthority) return { status: 'rejected', reason: 'mint_authority' };
  if (info.freezeAuthority) return { status: 'rejected', reason: 'freeze_authority' };

  const supply = BigInt(info.supply || '0');
  if (supply === 0n) throw new Error('Supply is zero');

  const largest = await rpc(rpcUrl, 'getTokenLargestAccounts', [coin.address], deadline);
  const holders = (largest && largest.value) || [];
  if (!holders.length) return { status: 'passed', top10Pct: 0 };

  const tokenAccounts = await rpc(
    rpcUrl,
    'getMultipleAccounts',
    [holders.map((h) => h.address), { encoding: 'jsonParsed' }],
    deadline
  );
  const owners = ((tokenAccounts && tokenAccounts.value) || []).map((acc) => {
    const parsed = acc && acc.data && acc.data.parsed;
    return (parsed && parsed.info && parsed.info.owner) || null;
  });

  const uniqueOwners = [...new Set(owners.filter(Boolean))];
  const ownerPrograms = new Map();
  if (uniqueOwners.length) {
    const ownerAccounts = await rpc(
      rpcUrl,
      'getMultipleAccounts',
      [uniqueOwners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
      deadline
    );
    ((ownerAccounts && ownerAccounts.value) || []).forEach((acc, i) => {
      ownerPrograms.set(uniqueOwners[i], acc ? acc.owner : null);
    });
  }

  const isPool = (holder, i) => {
    const owner = owners[i];
    if (coin.pairAddress && (holder.address === coin.pairAddress || owner === coin.pairAddress)) {
      return true;
    }
    const program = ownerPrograms.get(owner);
    return Boolean(program) && program !== SYSTEM_PROGRAM;
  };

  const wallets = holders
    .map((h, i) => ({ amount: BigInt(h.amount || '0'), pool: isPool(h, i) }))
    .filter((h) => !h.pool)
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
    .slice(0, 10);
  const top10 = wallets.reduce((sum, h) => sum + h.amount, 0n);
  const top10Pct = Number((top10 * 10000n) / supply) / 10000;

  if (top10Pct > maxTop10) return { status: 'rejected', reason: 'top10_holders', top10Pct };
  return { status: 'passed', top10Pct };
}

/**
 * Walks ranked coins in order until `want` pass. Rate limits, RPC errors and the
 * time budget never fail the request: affected coins stay in with safety "skipped".
 */
async function applySafetyChecks(ranked, { want, rpcUrl, budgetMs = 5000, concurrency = 4 }) {
  const deadline = now() + budgetMs;
  const accepted = [];
  const rejected = [];
  let skipped = 0;
  let checked = 0;
  let rateLimited = false;
  let budgetExceeded = false;
  let idx = 0;

  while (idx < ranked.length && accepted.length < want && !rateLimited && !budgetExceeded) {
    if (now() >= deadline) {
      budgetExceeded = true;
      break;
    }
    const wave = ranked.slice(idx, idx + concurrency);
    idx += wave.length;
    const results = await Promise.all(
      wave.map((coin) =>
        checkToken(coin, rpcUrl, deadline).catch((err) => ({
          status: 'skipped',
          reason:
            err instanceof RateLimited
              ? 'rate_limited'
              : err instanceof BudgetExceeded
                ? 'time_budget'
                : 'rpc_error',
        }))
      )
    );
    wave.forEach((coin, i) => {
      const r = results[i];
      if (r.status === 'rejected') {
        checked++;
        rejected.push({ address: coin.address, symbol: coin.symbol, reason: r.reason });
      } else if (r.status === 'passed') {
        checked++;
        accepted.push({ ...coin, safety: { status: 'passed', top10Pct: r.top10Pct } });
      } else {
        skipped++;
        if (r.reason === 'rate_limited') rateLimited = true;
        if (r.reason === 'time_budget') budgetExceeded = true;
        accepted.push({ ...coin, safety: { status: 'skipped', reason: r.reason } });
      }
    });
  }

  // Checks stopped early: keep filling the season in rank order without them.
  if (rateLimited || budgetExceeded) {
    const reason = rateLimited ? 'rate_limited' : 'time_budget';
    while (accepted.length < want && idx < ranked.length) {
      accepted.push({ ...ranked[idx++], safety: { status: 'skipped', reason } });
      skipped++;
    }
  }

  return {
    accepted: accepted.slice(0, want),
    rejected,
    checked,
    skipped,
    rateLimited,
    budgetExceeded,
  };
}

/* ---------- responses ---------- */

function sendJson(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(body));
}

module.exports = {
  DEX_BASE,
  PUBLIC_RPC_URL,
  SYSTEM_PROGRAM,
  isAddress,
  fetchJson,
  cached,
  discoverTokens,
  pickBestPairs,
  fetchBestPairs,
  normalizePair,
  isPumpfun,
  checkFilters,
  traction,
  checkToken,
  applySafetyChecks,
  sendJson,
  now,
  _setClock,
  _setRetryDelay,
  _resetCache,
};
