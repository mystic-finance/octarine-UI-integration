# Octarine demo (React + Vite)

A minimal app that creates auctions and accepts bids on them. Mirrors the [Integration Guide](../README.md): create request → market makers bid → accept → settle → record.

## Run

```bash
cd demo
npm install
npm run dev        # http://localhost:5173
```

Then: connect a wallet → pick a chain → pick a token pair and amount → **Create auction**. It appears under **My auctions**; once a market maker bids, hit **Accept**.

## Deploy

Cloudflare Workers static assets, configured in `wrangler.jsonc`:

```bash
npm run deploy      # builds, then npx wrangler deploy
```

First run will prompt you to log in. Change `name` in `wrangler.jsonc` to pick the `*.workers.dev` subdomain.

## Files

| File | What's in it |
|---|---|
| `src/api.js` | The Octarine API client — 6 endpoints, no wallet code. Copy this as-is. |
| `src/App.jsx` | `Swap` (create an auction) and `MyAuctions` (list + accept), plus `signerOn` / `executeBid`. |
| `src/styles.css` | Plain CSS, no framework. |

## Notes

- Points at **staging** (`https://staging-api.mysticfinance.xyz`). Change `BASE` in `src/api.js` to `https://api.mysticfinance.xyz` for production.
- No credentials anywhere — every endpoint the demo touches is open. See [Authentication](../README.md#authentication).
- Nothing appears under My auctions until you place one — the list is scoped to `fullAuctionEnabled=true`. Drop that filter in `MyAuctions` to also see instant-swap requests.
- If the chain selector and your wallet disagree, `signerOn` switches the wallet before signing. That is deliberate — see [Executing a bid](../README.md#4-execute-the-bid).
