# Octarine demo (React + Vite)

A minimal app that creates auctions and accepts bids on them. Mirrors the [Integration Guide](../README.md): create request → bidders bid → accept → settle → record.

Live at **[demo.octarine.finance](https://demo.octarine.finance/)**.

## Run

```bash
cd demo
npm install
npm run dev        # http://localhost:5173
```

The landing page is **instant swap**: it creates a 10-minute request, polls until a bid lands, then shows it in full before you accept.

The auctions page lives at **`/auctions`** (deliberately unlinked from the header). It creates a longer-running request and lists yours beside it; open one to see every bid.

## Deploy

Cloudflare Workers static assets, configured in `wrangler.jsonc`:

```bash
npm run deploy      # builds, then npx wrangler deploy
```

First run will prompt you to log in. Change `name` in `wrangler.jsonc` to pick the `*.workers.dev` subdomain.

## Files

Two pages over a shared set of modules, so you can lift one piece without the rest.

| | |
|---|---|
| `src/api.js` | The whole API surface, 8 endpoints. No wallet code, no React. |
| `src/lib/wallet.js` | Connect, pin the signer to a chain, run a bid's `txns`. |
| `src/lib/acceptBid.js` | Re-fetch, execute, then `/fill` or `/accept-delayed`. Both pages use it. |
| `src/lib/format.js` | Base-unit maths, countdowns, settlement time, slippage. |
| `src/pages/InstantSwap.jsx` | Swap now: create, poll for bids, show the best, accept. |
| `src/pages/Auctions.jsx` | Create an auction next to the user's auctions. |
| `src/components/AssetField.jsx` | Amount + token select, with balance and Max. |
| `src/components/BidDetails.jsx` | One bid in full: settlement time, duration covered, total slippage. |
| `src/components/BidsModal.jsx` | Every bid on an auction, each with Accept. |
| `src/components/CreateAuction.jsx`, `MyAuctions.jsx` | The two halves of the auctions page. |

The only difference between the two flows is the request you create: the instant
page sends a 10-minute `expiry`, the auctions page sends the duration you pick
plus `fullAuctionEnabled: true`. Accepting a bid is the same code either way.

## Notes

- Points at **production** (`https://api.mysticfinance.xyz`). Change `BASE` in `src/api.js` to `https://staging-api.mysticfinance.xyz` to run against staging.
- No credentials anywhere — every endpoint the demo touches is open. See [Authentication](../README.md#authentication).
- My auctions shows the full history. Add `open: true` to the `myOrders` call in `MyAuctions.jsx` for only the rows still worth acting on.
- If the chain selector and your wallet disagree, `signerOn` switches the wallet before signing. That is deliberate — see [Executing a bid](../README.md#4-execute-the-bid).
