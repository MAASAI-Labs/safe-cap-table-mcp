# SAFE & Cap Table Calculator (MCP server)

An MCP server that lets Grok Bot (or any MCP client) model startup financings: SAFEs, convertible notes, priced rounds, option pool shuffles, fees, and multi-step financing histories. It returns cap tables before and after, per-holder dilution and fully diluted ownership, as a markdown table plus structured JSON.

It works for any country and any currency, because amounts are unitless and shown with a `$` sign. It needs no API keys, makes no network calls and stores nothing. The math is deterministic.

## Tools

| Tool | What it does |
|---|---|
| `safe_ownership` | Implied ownership of post-money SAFEs (amount / post-money cap), combined SAFE dilution, MFN resolution, optional share estimates |
| `safe_conversion_price` | One SAFE or note: compares the cap price, discount price and round price, and returns the best-of conversion price and the share count |
| `model_priced_round` | Full round: converts post-money and pre-money SAFEs (cap, discount, MFN) and notes (with interest), issues new-money shares at a pre-money valuation or a fixed price, tops up the option pool (pre-money or post-money), and applies placement fees (cash and equity) and advisor grants |
| `model_round_sequence` | Runs events in order: SAFEs (including extensions at different caps), notes, priced rounds and milestone tranches at a fixed price or valuation |
| `compare_pool_timing` | The same round with the pool top-up in the pre-money vs the post-money, showing who bears the dilution |
| `explain_methodology` | Returns the formulas and conventions used |

All tools are read-only and idempotent. Invalid input returns a tool error that lists each bad field.

## Example prompts

- "I raised $1M on a $10M post-money SAFE. What do I own after it, and after a $10M Series A at $40M pre?"
- "Founders hold 8M shares and the pool is 2M. Model a $2M seed at $8M pre with the pool topped up to 10% post-money. Compare that with putting the pool in the post-money."
- "We have a $500k SAFE at a $6M cap with a 20% discount, a $250k MFN SAFE, and a $300k note at 8% for 18 months with a $5M cap. Convert them all in a $3M round at $12M pre."
- "Seed SAFE at a $10M cap, then an extension at $20M, then a Series A of $8M at $40M pre, then a second $2M tranche at $5/share. Show the cap table after each step."
- "Add a 5% cash and 2% equity placement fee, plus an advisor with 0.5% from the pool."

## Run locally

```bash
npm install
npm test            # unit tests (vitest)
npm run build
npm start           # Streamable HTTP at http://localhost:3000/mcp  (PORT to change)
npm run start:stdio # stdio transport for desktop MCP clients
npm run smoke       # lists tools and runs a sample round against the local HTTP server
```

Example stdio client config:

```json
{ "mcpServers": { "safe-cap-table": { "command": "node", "args": ["/path/to/safe-cap-table-mcp/dist/main-stdio.js"] } } }
```

## Deploy to Vercel

1. Push this repo to GitHub and import it at vercel.com/new (Framework preset: Other). No environment variables are needed.
2. Vercel serves `api/mcp.ts` as a Node function. `vercel.json` rewrites `/mcp` to `/api/mcp`.
3. Your MCP URL is `https://<project>.vercel.app/mcp`. Check it with `node scripts/smoke.mjs https://<project>.vercel.app/mcp`.

The server is stateless (no sessions, JSON responses), so it scales on serverless without sticky sessions. A GET request returns 405 by design.

## Methodology

- Fully diluted (FD) = issued shares + granted options + unallocated pool.
- Post-money SAFE (YC): cap price = cap / (pre-round FD + pre-money pool increase + all conversion shares). New-money shares excluded. Ownership at conversion ~= amount / cap.
- Pre-money SAFE and notes (default): cap price = cap / pre-round FD (excludes all converting securities and pool increase).
- Notes convert principal + simple interest (rate x days/365).
- Discount price = round price x (1 - discount). Holder gets the LOWEST of round, cap and discount prices.
- MFN SAFE: adopts lowest cap and highest discount among SAFEs listed after it.
- Pre-money pool: pool top-up counted in pre-money price (dilutes existing holders and pre-money instruments, not new investors or post-money SAFEs).
- Post-money pool: top-up issued after pricing; dilutes everyone, including new investors.
- Target pool % = unallocated pool / post-round FD (before advisor grants).
- Equity placement fee: shares at round price worth (fee% x new money), priced like new-money shares.
- Advisor grants: issued after close; fromPool=true reduces unallocated pool, otherwise new shares (percent sized so advisor holds that % of final FD).
- Circular round math solved by deterministic fixed-point iteration; shares rounded down per holder; price unrounded internally.
- This is a modelling tool, not legal, tax or investment advice. Confirm with counsel and your actual instruments.

YC references: Post-Money Safe User Guide (ycombinator.com/documents). A $1M SAFE on a $10M post-money cap owns 10% of the company capitalization at conversion, before new money.

## Testing instructions for marketplace reviewers

No credentials, accounts or API keys are needed.

1. Connect the MCP URL (or run `npm install && npm run build && npm start`, then use `http://localhost:3000/mcp`).
2. List tools. You should see 6 tools.
3. Call `model_priced_round` with:
   ```json
   {"capTable":[{"name":"Founders","shares":9000000},{"name":"Option pool","shares":1000000,"class":"pool"}],
    "safes":[{"name":"Seed SAFE","amount":1000000,"valuationCap":10000000}],
    "round":{"preMoneyValuation":40000000,"newInvestors":[{"name":"Lead","amount":10000000}]}}
   ```
   Expected: SAFE converts at $0.90 into 1,111,111 shares, the Series A price is $3.60, Lead holds 20.00%, the SAFE holds 8.00% and Founders hold 64.80%.
4. Call `compare_pool_timing` with founders at 10,000,000 shares, $8M pre, $2M raise and `targetPoolPercent: 0.1`. Expected: Founders get 70.00% with a pre-money pool vs 72.00% with a post-money pool. The price is $0.70 vs $0.80.
5. Send bad input (for example `round: {}`). Expected: a clear validation error, not a crash.

## Disclaimer

This is a modelling aid, not legal, tax or investment advice. Real instruments vary (for example pro-rata side letters, pay-to-play, or a non-standard definition of "Company Capitalization"). Check final numbers against your documents and counsel.

## License

MIT
