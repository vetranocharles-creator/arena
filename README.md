# Arena

A memecoin tournament demo. Real Solana market data from DexScreener, a simulated tournament, play money only. Nothing touches a blockchain and no real tokens are traded.

## Files

- `index.html` : the whole front end (inline CSS and JS, no frameworks)
- `api/pairs.js` : seeds a season with up to 8 real Solana pairs (filters and safety settings are constants at the top)
- `api/live.js` : fresh data for the tokens currently fighting, polled every 15s
- `api/_dex.js` : shared fetch, retry, caching, filters and scoring (not exposed as a route)
- `.env.example` : optional `SOLANA_RPC_URL`
- `test/api.test.js` : filtering and scoring tests against a mocked DexScreener (`npm test`)
- `test/dev-server.js` : local server with mocked, moving market data (`npm run dev`, then open http://localhost:3000)

Only real coins are used. There are no simulated or placeholder coins.

## Deploy on Vercel (beginner steps)

1. **Create a GitHub repo.** Go to github.com, click **New repository**, name it `arena`, keep it Public or Private, and click **Create repository**.
2. **Upload the files.** On the new repo page click **uploading an existing file**, then drag in everything from this folder, keeping the `api` and `test` folders as folders. Click **Commit changes**.
3. **Import into Vercel.** Go to vercel.com, sign in with GitHub, click **Add New... > Project**, find `arena` and click **Import**. Leave Framework Preset on **Other** and leave build settings empty.
4. **Add the environment variable (optional but recommended).** Still on the import screen, open **Environment Variables**. Name: `SOLANA_RPC_URL`. Value: your RPC URL, for example a free Helius URL `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` (sign up at helius.dev for the key). Skip this and the public Solana RPC is used, with safety checks skipped when it rate-limits.
5. **Deploy.** Click **Deploy**. After about a minute you get a link like `arena-yourname.vercel.app`. Open it: the badge should read "Real market data. Simulated tournament. Play money only."

To change the env variable later: Project > **Settings > Environment Variables**, then **Deployments > ... > Redeploy**.

## Notes

- The browser only calls `/api/*`. DexScreener responses are cached in memory (60s discovery, 15s pairs) and at Vercel's edge via `s-maxage`, which keeps you well inside the rate limits.
- If DexScreener is down or fewer than 8 tokens pass the filters, the page waits, shows a notice, and retries every 30 seconds until it has 8 real coins.
- Filters are strict on purpose. If you often see fewer than 8 live coins, loosen the constants at the top of `api/pairs.js`.
