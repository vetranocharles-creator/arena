'use strict';
// Local dev server: serves index.html and /api/* with a mocked DexScreener whose numbers drift over time.
// MOCK=down simulates an outage. Usage: node test/dev-server.js [port]
const http = require('http'), fs = require('fs'), path = require('path');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = (seed) => { let s = '', x = seed * 7919 + 13; for (let i = 0; i < 44; i++) { x = (x * 1103515245 + 12345) % 2147483648; s += B58[x % 58]; } return s; };
const NAMES = [['Bonk Jr','BONKJR'],['Wif Hat 2','WIF2'],['Goat Mode','GOATM'],['Chill Guy Classic','CHILL'],['Moo Deng Fan','MOODF'],['Popcat Prime','POPP'],['Fartcoin Lite','FRTL'],['Gigachad Sol','GIGA'],['Dog Cape','CAPE'],['Pnut Squad','PNUT']];
const tokens = NAMES.map(([name, symbol], i) => ({ address: addr(i + 1), pair: addr(i + 500), name, symbol, price: 0.0001 * (i + 1), vol: 20000 + i * 8000, created: Date.now() - (60 + i * 30) * 60000 }));
function mkPair(t) {
  t.price *= 1 + (Math.random() - 0.48) * 0.04;
  const b = 20 + Math.floor(Math.random() * 120), s = 10 + Math.floor(Math.random() * 110);
  return { chainId: 'solana', dexId: 'pumpswap', url: 'https://dexscreener.com/solana/' + t.pair, pairAddress: t.pair,
    baseToken: { address: t.address, name: t.name, symbol: t.symbol }, quoteToken: { symbol: 'SOL' },
    priceUsd: String(t.price), priceNative: String(t.price / 150),
    txns: { m5: { buys: b, sells: t.symbol === 'PNUT' ? b + 5 : Math.min(s, b - 1) }, h1: { buys: 400, sells: 250 }, h6: { buys: 1, sells: 1 }, h24: { buys: 1, sells: 1 } },
    volume: { m5: 2000 + Math.random() * 12000, h1: t.vol, h6: 1, h24: 1 },
    priceChange: { m5: (Math.random() - 0.45) * 12, h1: 25, h6: 1, h24: 1 },
    liquidity: { usd: 40000 + t.vol }, marketCap: t.price * 1e9, fdv: t.price * 1e9, pairCreatedAt: t.created,
    info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/mock-' + t.symbol + '.png' } };
}
global.fetch = async (url, init) => {
  const json = (b, st = 200) => ({ ok: st < 400, status: st, headers: { get: () => 'application/json' }, json: async () => b });
  if (process.env.MOCK === 'down') throw new Error('down');
  if (!url.startsWith('https://api.dexscreener.com')) return json({}, 429); // RPC: rate limited
  const p = url.replace('https://api.dexscreener.com', '');
  if (p.startsWith('/token-')) return json(tokens.map((t) => ({ chainId: 'solana', tokenAddress: t.address })));
  if (p.startsWith('/tokens/v1/solana/')) { const want = new Set(p.split('/').pop().split(',')); return json(tokens.filter((t) => want.has(t.address)).map(mkPair)); }
  return json({}, 404);
};
const root = path.join(__dirname, '..');
const handlers = { '/api/pairs': require('../api/pairs'), '/api/live': require('../api/live') };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (handlers[u.pathname]) return handlers[u.pathname](req, res);
  if (u.pathname === '/' || u.pathname === '/index.html') { res.setHeader('content-type', 'text/html'); return res.end(fs.readFileSync(path.join(root, 'index.html'))); }
  res.statusCode = 404; res.end('not found');
}).listen(+process.argv[2] || 3000, () => console.log('listening'));
