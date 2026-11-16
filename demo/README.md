# Octarine demo (React + Vite)

A minimal app that sells tokenised RWAs for stablecoins through the Octarine RFQ. Mirrors the [Integration Guide](../README.md): create request → sign it → solvers bid a rate → accept (`fillRFQOrder`) → record the actual payout.

Live at **[demo.octarine.finance](https://demo.octarine.finance/)**.

## Run

```bash
cd demo
npm install
npm run dev        # http://localhost:5173
```

The landing page is **instant swap**: it creates a 10-minute request, asks you to sign it, polls until a bid lands, re-quotes that bid on-chain, then shows it in full before you accept.

The **`/migrate`** page (header link **Migrate**) is for users coming from Octarine v1. It finds two things left on the v1 contract, and a banner on the other pages points to it while either exists:
- token approvals, which it revokes;
- open v1 requests, which no v2 bid can settle, so it closes them.

The auctions page lives at **`/auctions`** (deliberately unlinked from the header). You set your own minimum payout and maximum rate, sign, and the auction is published; your auctions are listed beside it. Open one to see every bid, sign one you left unsigned, or cancel one.

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
| `src/api.js` | The whole API surface. No wallet code, no React. |
| `src/lib/wallet.js` | Connect, pin the signer to a chain, the OctarineRFQ ABI, read schedules, sign the request, quote a bid (`quoteRFQOrder`), run a bid's `txns` (simulated first), parse `RFQOrderFilled`, cancel (`cancelSalt`), decode RFQ reverts. |
| `src/lib/acceptBid.js` | Re-fetch, check `makerExpiry`, re-quote, execute, then `/fill` with the actual amounts. Both pages use it. |
| `src/lib/legacy.js` | Migrating from v1: the v1 contract per chain, reading leftover approvals and revoking them, finding open v1 requests (no `requestHash` on `GET /request/:id`). |
| `src/lib/format.js` | Base-unit maths, countdowns, rate / horizon / discount display, the payout formula in BigInt, the pro-rata minimum. |
| `src/pages/InstantSwap.jsx` | Swap now: create, sign, poll for bids, show the best, accept, or cancel. |
| `src/pages/Auctions.jsx` | Create an auction next to the user's auctions. |
| `src/components/AssetField.jsx` | Amount + token select (limited to an allowed list), with balance and Max. |
| `src/components/BidDetails.jsx` | One bid in full: rate, horizon, discount, fee, quoted and minimum payout, expiry, settlement type. |
| `src/components/BidsModal.jsx` | Every bid on an auction, each with Accept. |
| `src/components/CreateAuction.jsx`, `MyAuctions.jsx` | The two halves of the auctions page. `MyAuctions` reads each open row's signed terms from `GET /request/:id`, because `GET /orders` rows are a summary, and labels v1 rows. |
| `src/components/LegacyMigration.jsx` | The `/migrate` page, the banner, and `useLegacyScan`, the hook both share. |

The only difference between the two flows is the request you create: the instant page sends a
10-minute `expiry` and lets the server derive the terms from `slippageTolerance`; the auctions page
sends the duration you pick, `fullAuctionEnabled: true`, and your own `minReceivedAmount` /
`takerMaxBpsPerDay` when you fill them in. Signing and accepting are the same code either way.

## What the user can pick

- **You sell:** only RWAs the chain's RFQ lists, i.e. those with a configured redemption schedule (`scheduleOf(asset).configured`) and not halted. `App.jsx` reads this straight from the contract, so the list is what the contract will actually price.
- **You receive:** stablecoins only (`isStable` in `GET /tokens`).

## Notes

- Points at **staging** (`https://staging-api.mysticfinance.xyz`). Change `BASE` in `src/api.js` to `https://api.mysticfinance.xyz` for production.
- Restricted to **Sepolia**. `ALLOWED_CHAINS` in `src/App.jsx` is the allowlist; widen it, or drop the filter, to offer every chain `GET /chains` returns. Add an RPC to `RPC` in `src/lib/wallet.js` for each chain you add, so schedules and quotes don't depend on the wallet's network.
- The RFQ address comes from `rfq` in `GET /chains`. Nothing is hard-coded, and `signRequest` refuses to sign typed data whose `verifyingContract` doesn't match it.
- No credentials anywhere. The user's EIP-712 signature over the request is what authorises the trade. See [Authentication](../README.md#authentication).
- My auctions shows the full history. Add `open: true` to the `myOrders` call in `MyAuctions.jsx` for only the rows still worth acting on.
- If the chain selector and your wallet disagree, `signerOn` switches the wallet before signing or sending. That is deliberate; see [Pitfalls](../README.md#pitfalls).
- Escrowed settlement, Dutch auctions and cross-chain fills are not part of this demo.
