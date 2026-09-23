'use strict';
// Run with: npm test   (no dependencies; mocks global fetch)
const assert = require('assert');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = (seed) => { let s = ''; let x = seed * 7919 + 13; for (let i = 0; i < 44; i++) { x = (x * 1103515245 + 12345) % 2147483648; s += B58[x % 58]; } return s; };
const NOW = Date.now();
const min = (m) => NOW - m * 60000;

// ---- token fixtures ----
function pair(o) {
  return {
    chainId: 'solana', dexId: 'raydium', url: `https://dexscreener.com/solana/${o.pairAddress || addr(o.seed + 1000)}`,
    pairAddress: o.pairAddress || addr(o.seed + 1000),
    baseToken: { address: o.address, name: o.name, symbol: o.symbol },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
    priceUsd: String(o.priceUsd ?? 0.0003), priceNative: String((o.priceUsd ?? 0.0003) / 160),
    txns: { m5: { buys: o.m5b ?? 40, sells: o.m5s ?? 20 }, h1: { buys: o.h1b ?? 300, sells: o.h1s ?? 200 }, h6: { buys: 1, sells: 1 }, h24: { buys: 1, sells: 1 } },
    volume: { m5: 3000, h1: o.volH1 ?? 40000, h6: 1, h24: 1 },
    priceChange: { m5: 2, h1: o.chgH1 ?? 10, h6: 1, h24: 1 },
    liquidity: { usd: o.liq ?? 30000 },
    marketCap: o.mc === undefined ? 200000 : o.mc,
    fdv: o.fdv ?? 210000,
    pairCreatedAt: o.created ?? min(120),
    info: { imageUrl: 'https://cdn.dexscreener.com/x.png' },
    ...(o.boost ? { boosts: { active: 5 } } : {}),
  };
}

const T = {};
const good = [];
for (let i = 1; i <= 10; i++) {
  T['good' + i] = { seed: i, address: addr(i), name: 'Good ' + i, symbol: 'GD' + i, volH1: 10000 + i * 5000 };
  good.push(T['good' + i]);
}
T.fdvOnly = { seed: 20, address: addr(20), name: 'FdvOnly', symbol: 'FDV', mc: null, fdv: 30000, volH1: 6000 };
T.tooYoung = { seed: 21, address: addr(21), name: 'Young', symbol: 'YNG', created: min(5), volH1: 900000 };
T.tooOld = { seed: 22, address: addr(22), name: 'Old', symbol: 'OLD', created: min(25 * 60), volH1: 900000 };
T.sellPressure = { seed: 23, address: addr(23), name: 'Dump', symbol: 'DUMP', m5b: 10, m5s: 10, volH1: 900000 };
T.fewTxns = { seed: 24, address: addr(24), name: 'Quiet', symbol: 'QT', h1b: 30, h1s: 19, volH1: 900000 };
T.lowVol = { seed: 25, address: addr(25), name: 'LowVol', symbol: 'LV', volH1: 4999 };
T.lowLiq = { seed: 26, address: addr(26), name: 'LowLiq', symbol: 'LL', liq: 4000, volH1: 900000 };
T.lowMc = { seed: 27, address: addr(27), name: 'LowMc', symbol: 'LMC', mc: 15000, volH1: 900000 };
T.multiPair = { seed: 28, address: addr(28), name: 'Multi', symbol: 'MULTI', volH1: 12000 };
T.mintAuth = { seed: 29, address: addr(29), name: 'Minty', symbol: 'MINT', volH1: 500000 };   // top traction but unsafe
T.whales = { seed: 30, address: addr(30), name: 'Whales', symbol: 'WHALE', volH1: 400000 };  // concentrated
T.poolHeavy = { seed: 31, address: addr(31), name: 'PoolHeavy', symbol: 'POOL', volH1: 300000 }; // big holder is the pool

const allTokens = Object.values(T);
const pairsByAddr = new Map(allTokens.map((t) => [t.address, [pair(t)]]));
// multiPair: a tiny failing pair plus a big passing one; best pair must be the high-liquidity one
pairsByAddr.get(T.multiPair.address).unshift(pair({ ...T.multiPair, seed: 99, liq: 1000, m5b: 1, m5s: 50 }));
// a pair where one of our tokens is only the quote side: must be ignored
pairsByAddr.get(T.good1.address).push({ ...pair({ seed: 98, address: addr(98), name: 'Other', symbol: 'OTH', liq: 999999 }) });

const discovery = [
  ...allTokens.slice(0, 12).map((t) => ({ chainId: 'solana', tokenAddress: t.address, icon: 'https://cdn.dexscreener.com/i.png', url: 'u' })),
  { chainId: 'ethereum', tokenAddress: '0xabc', icon: null },
];
const boostsLatest = [
  ...allTokens.slice(10).map((t) => ({ chainId: 'solana', tokenAddress: t.address, icon: null })),
  { chainId: 'solana', tokenAddress: T.good1.address }, // duplicate
];
const boostsTop = [{ chainId: 'solana', tokenAddress: T.good2.address }];

// ---- RPC fixtures ----
const SUPPLY = 1_000_000_000_000;
function rpcResult(method, params) {
  const mint = params[0];
  if (method === 'getParsedAccountInfo') {
    return { value: { data: { parsed: { info: { mintAuthority: mint === T.mintAuth.address ? addr(500) : null, freezeAuthority: null, supply: String(SUPPLY), decimals: 6 } } } } };
  }
  if (method === 'getTokenLargestAccounts') {
    const big = mint === T.whales.address || mint === T.poolHeavy.address;
    const accts = Array.from({ length: 20 }, (_, i) => ({ address: `${mint.slice(0, 30)}acct${String(i).padStart(2, '0')}`.slice(0, 44), amount: String(big && i === 0 ? SUPPLY * 0.5 : SUPPLY * 0.01) }));
    return { value: accts };
  }
  if (method === 'getMultipleAccounts') {
    return { value: params[0].map((a, i) => {
      let owner = addr(700 + i);
      if (i === 0 && a.startsWith(T.poolHeavy.address.slice(0, 30))) owner = pair(T.poolHeavy).pairAddress;
      return { data: { parsed: { info: { owner } } } };
    }) };
  }
  throw new Error('unknown method ' + method);
}

let dexCalls = [];
let rpcMode = 'ok';
global.fetch = async (url, init = {}) => {
  const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });
  if (url.startsWith('https://api.dexscreener.com')) {
    dexCalls.push(url);
    const path = url.replace('https://api.dexscreener.com', '');
    if (path === '/token-profiles/latest/v1') return json(discovery);
    if (path === '/token-boosts/latest/v1') return json(boostsLatest);
    if (path === '/token-boosts/top/v1') return json(boostsTop);
    if (path.startsWith('/tokens/v1/solana/')) {
      const list = path.split('/').pop().split(',');
      assert.ok(list.length <= 30, 'max 30 addresses per pair call');
      return json(list.flatMap((a) => pairsByAddr.get(a) || []));
    }
    return json({}, 404);
  }
  // RPC
  if (rpcMode === 'ratelimited') return json({}, 429);
  const body = JSON.parse(init.body);
  return json({ jsonrpc: '2.0', id: 1, result: rpcResult(body.method, body.params) });
};

function mockRes() {
  return { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = JSON.parse(b); } };
}

(async () => {
  const dex = require('../api/_dex');
  const pairsHandler = require('../api/pairs');
  const liveHandler = require('../api/live');
  let passed = 0;
  const ok = (name) => { passed++; console.log('  ✓ ' + name); };

  // ---- unit: filters ----
  const F = pairsHandler.FILTERS;
  // Fixtures use the original strict thresholds on Raydium pairs; test pump.fun detection separately.
  const LIVE = { ...F };
  Object.assign(F, { PUMPFUN_ONLY: false, MIN_MARKET_CAP_USD: 20000, MIN_H1_TXNS: 50, REQUIRE_M5_BUYS_GT_SELLS: true });
  assert.ok(dex.isPumpFun({ address: addr(5).slice(0, 40) + 'pump', dexId: 'raydium' }));
  assert.ok(dex.isPumpFun({ address: addr(5), dexId: 'pumpswap' }));
  assert.ok(!dex.isPumpFun({ address: addr(5), dexId: 'raydium' }));
  assert.deepStrictEqual(dex.checkFilters({ ...dex.normalizePair(pair(T.good1), NOW) }, { ...F, PUMPFUN_ONLY: true }).reasons, ['notPumpFun']);
  assert.strictEqual(LIVE.PUMPFUN_ONLY, true);
  ok('pump.fun-only filter keeps pump.fun mints and PumpSwap pairs');
  const norm = (t) => dex.normalizePair(pair(t), NOW);
  assert.ok(dex.checkFilters(norm(T.good1), F).ok); ok('good token passes filters');
  assert.ok(dex.checkFilters(norm(T.fdvOnly), F).ok); assert.strictEqual(norm(T.fdvOnly).marketCap, 30000); ok('null marketCap falls back to fdv');
  const rej = (t, reason) => assert.deepStrictEqual(dex.checkFilters(norm(t), F).reasons, [reason]);
  rej(T.tooYoung, 'age'); rej(T.tooOld, 'age'); rej(T.sellPressure, 'm5Pressure'); rej(T.fewTxns, 'h1Txns');
  rej(T.lowVol, 'h1Volume'); rej(T.lowLiq, 'liquidity'); rej(T.lowMc, 'marketCap');
  ok('each filter rejects exactly its own failure case');

  // null-safe normalisation
  const sparse = dex.normalizePair({ baseToken: { address: addr(77), name: null, symbol: 'X' }, pairAddress: addr(78) }, NOW);
  assert.strictEqual(sparse.marketCap, 0); assert.strictEqual(sparse.txns.m5.buys, 0); assert.strictEqual(sparse.ageMinutes, null); assert.strictEqual(sparse.name, 'Unknown');
  assert.strictEqual(dex.checkFilters(sparse, F).ok, false);
  ok('sparse pair with null fields normalises safely and is filtered out');

  // ---- unit: traction ----
  const t1 = norm({ ...T.good1, volH1: 10000, h1b: 300, h1s: 200, chgH1: 10 });
  assert.strictEqual(dex.tractionScore(t1), 10 + 50 + 2);
  const t2 = norm({ ...T.good1, volH1: 10000, h1b: 300, h1s: 200, chgH1: 10, boost: true });
  assert.strictEqual(dex.tractionScore(t2), 64);
  ok('traction score = vol.h1/1000 + (buys-sells)*0.5 + chg.h1*0.2 + boost 2');

  // ---- unit: best pair ----
  const best = dex.bestPairByToken(pairsByAddr.get(T.multiPair.address));
  assert.strictEqual(best.get(T.multiPair.address).liquidity.usd, 30000);
  ok('token with several pairs uses the highest-liquidity pair');

  // ---- /api/pairs end to end ----
  let res = mockRes();
  await pairsHandler({ url: '/api/pairs' }, res);
  assert.strictEqual(res.statusCode, 200);
  const body = res.body;
  const syms = body.tokens.map((t) => t.symbol);
  assert.strictEqual(body.tokens.length, 8, 'returns top 8');
  assert.ok(!syms.includes('MINT'), 'mint authority rejected');
  assert.ok(!syms.includes('WHALE'), 'concentrated holders rejected');
  assert.ok(syms.includes('POOL'), 'pool account excluded from concentration');
  for (const bad of ['YNG', 'OLD', 'DUMP', 'QT', 'LV', 'LL', 'LMC', 'OTH']) assert.ok(!syms.includes(bad), bad + ' excluded');
  const tr = body.tokens.map((t) => t.traction);
  assert.deepStrictEqual(tr, [...tr].sort((a, b) => b - a), 'sorted by traction');
  assert.strictEqual(syms[0], 'POOL');
  assert.deepStrictEqual(body.stats.safetyRejected.map((r) => r.symbol).sort(), ['MINT', 'WHALE']);
  assert.strictEqual(body.solUsd, 160);
  for (const k of ['address', 'pairAddress', 'name', 'symbol', 'imageUrl', 'priceUsd', 'marketCap', 'liquidityUsd', 'volume', 'txns', 'priceChange', 'ageMinutes', 'dexscreenerUrl']) {
    assert.ok(k in body.tokens[0], 'field ' + k);
  }
  assert.match(res.headers['cache-control'], /s-maxage=60/);
  ok(`/api/pairs returns 8 ranked, safe tokens: ${syms.join(', ')}`);

  // cache: second call within 60s does not hit DexScreener again
  const before = dexCalls.length;
  res = mockRes(); await pairsHandler({ url: '/api/pairs' }, res);
  assert.strictEqual(dexCalls.length, before); ok('season result cached (no extra DexScreener calls)');

  // RPC rate limited -> checks skipped gracefully, still 8 tokens
  dex.clearCache(); rpcMode = 'ratelimited';
  res = mockRes(); await pairsHandler({ url: '/api/pairs' }, res);
  assert.strictEqual(res.body.tokens.length, 8);
  assert.ok(res.body.tokens.every((t) => t.safety.status === 'skipped'));
  rpcMode = 'ok';
  ok('rate-limited RPC skips safety checks without failing');

  // ---- /api/live ----
  dex.clearCache(); dexCalls = [];
  res = mockRes();
  await liveHandler({ url: `/api/live?addresses=${T.good1.address},${T.good2.address},${T.good1.address},notanaddress,${addr(4242)}` }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(res.body.tokens).sort(), [T.good1.address, T.good2.address].sort());
  assert.deepStrictEqual(res.body.missing, [addr(4242)]);
  assert.strictEqual(res.body.tokens[T.good1.address].symbol, 'GD1', 'quote-side pair ignored');
  assert.strictEqual(dexCalls.length, 1, 'one DexScreener call');
  assert.match(res.headers['cache-control'], /s-maxage=15/);
  ok('/api/live validates, dedupes, uses one call, reports missing');

  res = mockRes(); await liveHandler({ url: '/api/live?addresses=' }, res);
  assert.strictEqual(res.statusCode, 400); ok('/api/live rejects empty input');

  // ---- DexScreener down -> 502 with empty tokens (front end falls back) ----
  dex.clearCache();
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  res = mockRes(); await pairsHandler({ url: '/api/pairs' }, res);
  assert.strictEqual(res.statusCode, 200); assert.strictEqual(res.body.mode, 'unavailable'); assert.deepStrictEqual(res.body.tokens, []);
  global.fetch = realFetch;
  ok('DexScreener outage returns an empty token list so the page falls back');

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
