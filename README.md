# Octarine

Octarine is an RFQ and auction venue for tokenised real-world assets and other instruments with no liquid pool to trade against. You publish an *intent* — "sell 10,000 uMINT for USDC" — bidders bid on it, and you accept the bid you want. Settlement is on-chain and non-custodial.

| | |
|---|---|
| **Production** | `https://api.mysticfinance.xyz` |
| **Staging** | `https://staging-api.mysticfinance.xyz` — same API, safe to experiment against |
| **All routes below** | prefixed `/octarine` |
| **Interactive API docs** | [Swagger](https://api.mysticfinance.xyz/docs) ([staging](https://staging-api.mysticfinance.xyz/docs)) |
| **Live demo** | [demo.octarine.finance](https://demo.octarine.finance/) — source in [`demo/`](demo) |
| **Support** | [joao.moreira@mysticfinance.xyz](mailto:joao.moreira@mysticfinance.xyz) |

---

## Contents

- [How it works](#how-it-works)
- [Request types](#request-types)
- [Conventions](#conventions)
- [Authentication](#authentication)
- [Quickstart](#quickstart)
- [Instant vs delayed settlement](#instant-vs-delayed-settlement)
- [Listing a user's requests](#listing-a-users-requests)
- [Pitfalls](#pitfalls)
- [API reference](#api-reference)
- [Real-time updates](#real-time-updates)
- [Supported chains](#supported-chains)
- [Fees](#fees)
- [Errors](#errors)

---

## How it works

```
  1. CREATE            2. BID              3. ACCEPT            4. SETTLE
  ┌──────────┐      ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
  │ Post an  │      │   Bidders    │    │ Pick the bid │    │ Swap settles │
  │ intent to│─────▶│ price it and │───▶│ you want     │───▶│ on-chain     │
  │ sell X   │      │ sign an offer│    │              │    │              │
  └──────────┘      └──────────────┘    └──────────────┘    └──────────────┘
   POST /swap                            GET /swap/:id       depends on the
   → requestId                           → bids[]            bid's settlementType
```

A **request** is the user's intent, keyed by `requestId` (a UUID). A **bid** is a bidder's signed offer against it, keyed by `bidId`. Accepting a bid hands you either ready-to-sign calldata or a single API call, depending on the bid's settlement type. Funds never leave the user's wallet until the swap executes.

---

## Request types

Both come from `POST /octarine/swap`. `fullAuctionEnabled` is the only difference in the body, and it is narrower than it looks.

| | **Instant** | **Auction** |
|---|---|---|
| Body | `fullAuctionEnabled` omitted or `false` | `fullAuctionEnabled: true` |
| Typical `expiry` | Minutes as you expect an answer now | Hours or days as you're waiting for price discovery |
| Use for | Pairs with resting liquidity | Illiquid assets, large size, anything needing price discovery |

**Both instant and full auctions produce the same record**, and bidders bid on both the same way. `fullAuctionEnabled` is a discoverability tag  used to filter instant and full auctions; the endpoint returns everything when the filter is omitted. The real difference is the `expiry` you choose, and that is a single decision made at creation time.

An empty `bids` array is not an error and not a dead end. The request stays live and biddable until `expiryTime`, so you can **keep polling the same `requestId`** to get updates on the request.

---

## Conventions

**Amounts are integers in the token's smallest unit, as decimal strings.** `100 USDC` (6 decimals) is `"100000000"`, never `100`, never `"100.0"`. Get `decimals` from `GET /octarine/tokens`.

**The naming is redemption-flavoured.** Requests and bids describe the same two tokens with different words:

| Request field | Bid field | Meaning |
|---|---|---|
| `redeemAsset` | `takerToken` | The token being **sold** |
| `redemptionAsset` | `makerToken` | The token being **bought** |
| `amount` / `redeemAmount` | `takerAmount` | Sell size, base units |
| — | `makerAmount` | What the maker offers, base units |

**Timestamps are unix seconds** (`expiryTime`, `biddingCloseTime`, `bid.expiry`), except `createdAt`/`updatedAt` which are ISO 8601.

---

Every example below uses production. Swap the base url for `staging-api.mysticfinance.xyz` to point the same calls at staging.

```js
const BASE = 'https://api.mysticfinance.xyz/octarine';
```

---

## Authentication

**The user flow needs no credentials.** Loading tokens, estimating a price, creating a request, reading bids, accepting, and recording a fill are all open.

`DELETE /octarine/request/:requestId` is gated on an origin allowlist that defaults to deny, assume you cannot cancel programmatically unless your domain has been allowlisted.

---

## Quickstart

### 1. Load chains and tokens

```js
const { data: chains } = await (await fetch(`${BASE}/chains`)).json();
// [{ chainId: 98866, name: 'Plume Mainnet', exchangeProxy: '0x900b…', supported: true }, …]

const tokens = await (await fetch(`${BASE}/tokens`)).json();
const onChain = tokens.filter((t) => t.chainId === 98866);
// [{ chainId, address, symbol, name, decimals, logoURI }, …]
```


### 2. Preview the price

```js
const q = new URLSearchParams({ chainId: 98866, redeemAsset: SELL, redemptionAsset: BUY, amount: '100000000' });
const { data } = await (await fetch(`${BASE}/price/estimate?${q}`)).json();
```

```json
{
  "price": 1,
  "inputAmount": "100000000",
  "outputAmount": "99990000",
  "fee": 10000,
  "inputAmountAfterFee": "99990000",
  "redeemAssetInfo": { "decimals": 6, "priceUSD": 1 },
  "redemptionAssetInfo": { "decimals": 6, "priceUSD": 1 }
}
```

An **oracle estimate**, not a tradeable quote, no bidder has committed to it. It creates nothing, so it's safe to call on every keystroke.

### 3. Create the request

```js
const res = await fetch(`${BASE}/swap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chainId: 98866,
    walletAddress: userAddress,
    redeemAsset: SELL,
    redemptionAsset: BUY,
    amount: '100000000',
    expiry: 1440,              // minutes
    slippageTolerance: 10,     // percent
    swapType: 'direct',
    fullAuctionEnabled: true,
  }),
});
if (!res.ok) throw new Error((await res.json()).message);
const request = await res.json();
```

```json
{
  "type": "rfq",
  "requestId": "7f80e8a4-5c0e-4feb-8b45-c6f4fa385c6d",
  "message": "RFQ created with initial bids.",
  "fee": 10000,
  "feeRecipient": "0x0D4e1E488308f2B06f1AdED77170D56BD44CDbF2",
  "request": { "status": "pending", "expiryTime": 1786567359, "…": "…" },
  "bids": [],
  "totalBuyAmount": "0"
}
```

> **This is a write.** Every call publishes a live RFQ that bidders can bid on.

Keep `requestId`. It is the handle for everything downstream.

### 4. Read the bids

```js
const { status, bids, totalBuyAmount } = await (await fetch(`${BASE}/swap/${requestId}`)).json();
```

```json
{
  "status": "bidding",
  "totalBuyAmount": "231359",
  "bids": [
    {
      "bidId": "dbf43493-dbe4-4c15-9f13-19d37497d9ac",
      "marketMaker": "0x346298209c3accdf53d56b624cee10b56ca308de",
      "marketMakerName": "Test Provider3",
      "makerToken": "0x754704bc059f8c67012fed69bc8a327a5aafb603",
      "takerToken": "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
      "makerAmount": "231359",
      "takerAmount": "10000000",
      "price": 0.0231359,
      "slippage": 0.12,
      "networkCostUSD": 0.04,
      "settlementType": "instant",
      "estimatedSettlementTime": 60,
      "trustScore": 87,
      "fee": 10000,
      "expiry": 1791381413,
      "metadata": { "redeemAssetData": { "decimals": 6, "symbol": "WMON" },
                    "redemptionAssetData": { "decimals": 6, "symbol": "USDC" } },
      "txns": [
        { "type": "approval", "to": "0x3bd3…433a", "data": "0x095ea7b3…" },
        { "type": "execute",  "to": "0x151c…Fa8E", "data": "0x6a761202…" }
      ]
    }
  ]
}
```

Bids come back **ranked best-first, top 3 only**.

#### Polling

`bids: []` means nobody has bid *yet*. Poll the same `requestId`, the request accepts bids for its whole window, and nothing about it needs re-creating:

```js
async function waitForBids(requestId, { attempts = 15, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { bids } = await (await fetch(`${BASE}/swap/${requestId}`)).json();
    if (bids.length) return bids;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return [];   // still live — poll again later, or let the user come back to it
}
```

How long you poll is a UI decision, not a protocol one. A short `expiry` request usually wants a tight loop and a fallback; a long one wants no loop at all, persist the `requestId`, list it from `GET /orders/:address`, and re-read `GET /swap/:requestId` when the user opens it. Or skip polling entirely and subscribe to [`new_bid`](#real-time-updates).

Bids also *disappear* between polls. Each carries its own `expiry`, and only bids that are still `pending` and unexpired are returned, so a bid you showed a minute ago may be gone, which is one more reason to re-read before accepting.

**Read `settlementType` on every bid before you do anything with it.** It decides how the bid is accepted, and the two paths share no code. See the next section.

### 5. Accept

Branch on `settlementType`:

```js
if (bid.settlementType === 'delayed') {
  await acceptDelayed(requestId, bid.bidId);   // one API call, no wallet tx
} else {
  const txHash = await executeBid(bid, request.chainId, userAddress);
  await recordFill(requestId, bid, txHash);
}
```

### 6. Record the fill (instant only)

```js
await fetch(`${BASE}/fill`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    requestId,
    bidId: bid.bidId,
    txHash,
    filledAmount: bid.takerAmount,
    marketMaker: bid.marketMaker,
  }),
});
```

The swap already happened on-chain; this closes the loop. Octarine verifies the hash against the receipt and its fill event before flipping the request to `filled`, so a spoofed hash records nothing.

**Retry it.** It's idempotent, the backend guards on the bid's status, so a repeat can't double-count.

---

## Instant vs delayed settlement

Every bid carries `settlementType`, and it is the **only** correct discriminator. Both kinds may arrive on the same request, in the same `bids` array, ranked together.

|  | **`settlementType: "instant"`** | **`settlementType: "delayed"`** |
|---|---|---|
| What the bidder is saying | "I have the funds now" | "I'll settle within a window" |
| `estimatedSettlementTime` | `60` (a nominal one-minute pad) | The real window, **in seconds** (e.g. `86400` = 24h) |
| How you accept | Send `bid.txns` | Send `bid.txns`, then `POST /swap/:requestId/accept-delayed` |
| `bid.txns` holds | approval + execute | approval only, pre-authorising the later pull |
| Then | `POST /fill` with the tx hash | Nothing because Octarine settles it when the bidder funds |
| Request status after | `filled` | `solving`, then `filled` on settlement |

> **Do not check on whether `txns` is present.** Both kinds carry `txns`, they just contain different steps. Check the `settlementType`, always.

### Accepting an instant bid

Send each entry in `bid.txns` in order. The array is normally `[approval, execute]`; the hash of the **last** one is the fill hash.

```js
import { ethers } from 'ethers';

async function executeBid(bid, chainId, owner) {
  // The wallet's live network drifts from your app's selected chain, and the
  // calldata was built for ONE chain. Switch, then re-verify — BrowserProvider
  // caches the network it saw at construction, so rebuild it after switching.
  let provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  if (Number((await provider.getNetwork()).chainId) !== chainId) {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + chainId.toString(16) }],
    });
    provider = new ethers.BrowserProvider(window.ethereum);
    if (Number((await provider.getNetwork()).chainId) !== chainId) {
      throw new Error(`Switch your wallet to chain ${chainId}.`);
    }
  }
  const signer = await provider.getSigner();

  let hash = '';
  for (const tx of bid.txns) {
    if (tx.type === 'approval') {
      // Skip an approval already covered. Re-prompting is bad UX, and some
      // tokens revert on a non-zero → non-zero allowance change, which breaks
      // every retry after a cancelled attempt.
      const iface = new ethers.Interface(['function approve(address,uint256)']);
      const [spender, needed] = iface.decodeFunctionData('approve', tx.data);
      const erc20 = new ethers.Contract(
        tx.to, ['function allowance(address,address) view returns (uint256)'], signer);
      if ((await erc20.allowance(owner, spender)) >= BigInt(needed)) continue;
    }
    const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value || undefined });
    await sent.wait();
    hash = sent.hash;
  }
  return hash;
}
```

Then `POST /fill`.

### Accepting a delayed bid

First send `bid.txns` — for a delayed bid that's normally the approval alone. It pre-authorises the pull so the bidder can settle later without another signature from the user.

Then accept. No `POST /fill`, since there's no fill hash yet.

```js
const res = await fetch(`${BASE}/swap/${requestId}/accept-delayed`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ bidId }),
});
const { data } = await res.json();
// { requestId, status: 'solving', scheduleSettlementTime: '2026-08-13T16:27:40.669Z' }
```

This closes the auction and locks the bid: the request moves to `solving`, the bid to `accepted`, every other bid is out.

**Settling later:** Octarine polls the **maker's** wallet each minute for the `makerAmount` they owe. Once it's covered, the swap executes against that pre-signed approval and the request flips to `filled` — no user action. If the maker never funds by `scheduleSettlementTime`, the request and bid are cancelled and a fresh short auction opens automatically for the same trade.

Show `scheduleSettlementTime` as the settlement deadline. Poll `GET /swap/:requestId` or listen for `settlement_completed`.

**Rejections**, all `400` with the reason in `message`:

| Cause | Fix |
|---|---|
| Request is not `pending`, `bidding` or `ready_for_solve` | Already accepted, expired, or settling. Reload. |
| Bid is not `settlementType: "delayed"` | You branched wrong — use the `txns` flow. |
| Bid is no longer `pending` | Cancelled, expired, or accepted elsewhere. Re-read the bids. |
| Bid's signature expires before the settlement deadline | The bidder's offer can't cover its own window. Pick another bid. |

---

## Listing a user's requests

`GET /orders/:address` returns every request a wallet placed, newest first, the data behind an "my orders" view.

```js
const q = new URLSearchParams({ chainId, page: 1, limit: 10, timeRange: 'all_time' });
const { data } = await (await fetch(`${BASE}/orders/${userAddress}?${q}`)).json();
```

```json
{
  "summary": { "totalVolume": "1.0657", "totalTrades": 11, "uniqueTokensTraded": 10 },
  "transactions": {
    "data": [
      {
        "requestId": "1291798b-b0ef-4000-bd0d-9538dced24b8",
        "date": "2026-07-14T14:40:00.011Z",
        "type": "swap",
        "sellToken": { "address": "0x1111…e94b", "symbol": "NBASIS", "amount": 0.08 },
        "buyToken":  { "address": "0xdddd…6f3f", "symbol": "PUSD",   "amount": 0 },
        "txHash": null,
        "chainId": 98866,
        "status": "expired",
        "expiryTime": 1784039842,
        "bid": null
      }
    ],
    "page": 1, "limit": 10, "totalItems": 20, "totalPages": 10
  }
}
```

Two things make this the right endpoint for a history view:

- **`amount` is already human-scaled** — a float, not base units. The only endpoint that does the decimal maths for you.
- **`bid`** carries the best active bid inline on every non-filled row, so a table can show a live number without a fetch per row. `null` when there are none.

Add `fullAuctionEnabled=true` to narrow it to full auction flow requests only; omit it and you get everything the wallet placed. Filtering and pagination are server-side, don't fetch `limit=200` and filter in the client.

### Only the ones the user can act on

For a queue view — "here's what's waiting on you" rather than a full history — pass `open=true`:

```js
const q = new URLSearchParams({ user: userAddress, chainId, open: true, limit: 10 });
const { data } = await (await fetch(`${BASE}/orders/${userAddress}?${q}`)).json();
```

That's shorthand for *pending or bidding, and not past `expiryTime`*. Filled, cancelled and expired rows never come back, so every row you get has an Accept button on it and you can skip the state derivation below entirely.

For anything more specific, `status` takes a comma-separated list of request statuses:

| Want | Send |
|---|---|
| Still actionable | `open=true` |
| Bids have landed | `status=bidding` |
| Closed out | `status=filled,cancelled,expired` |
| Everything | *neither* |

Two things to know about `status`: it **overrides `open`** when both are sent, and unlike `open` it is **not expiry-guarded** — a row still marked `bidding` in the database shows up even if its window has closed, because hiding the user's own order would make it look like it never existed. An unrecognised value is a `400` listing the valid ones, rather than an empty list you'd have to debug.

---

## Pitfalls

**Never cache `txns`.** The `execute` transaction bundles a nonce that advances whenever any other order on that chain settles. Calldata fetched when a screen opened can be stale by the time the user clicks accept, and it fails *after* they've already paid for the approval. Re-fetch `GET /swap/:requestId` inside the click handler, match on `bidId`, send that.

**Empty `txns` is transient.** Tell the user to retry in a few seconds; don't mark the bid dead.

**Settle on the request's chain**, never the wallet's current network. A request created on Ethereum must settle on Ethereum even if the user has since switched.

**`fee` is in raw sell-token units and `takerAmount` is already net of it**, so the rate is `fee / (takerAmount + fee)`.


---

## API reference

All routes prefixed `/octarine`.

### `POST /swap`

Create a request. Blocks up to ~3s so an already-standing bidder can answer inline.

| Field | Type | Required | Description |
|---|---|---|---|
| `walletAddress` | string | ✅ | The user's wallet. Owns the request. |
| `redeemAsset` | string | ✅ | Token being **sold**. |
| `redemptionAsset` | string | ✅ | Token being **bought**. |
| `amount` | string | ✅ | Sell size, base units. |
| `chainId` | integer | ✅ | Must be supported. |
| `expiry` | integer | — | Bidding window in **minutes**. Default `15`. |
| `slippageTolerance` | number | — | Percent. Default `1`. |
| `swapType` | string | — | `direct` (default — the user sends the fill) or `system` (bundled execution). |
| `fullAuctionEnabled` | boolean | — | Marks it as an auction. Default `false`. |

**Response**

| Field | Type | Description |
|---|---|---|
| `type` | string | `rfq`. |
| `requestId` | string | UUID. |
| `message` | string | Human-readable state. |
| `fee` | number | Protocol fee, raw **sell-token** units. |
| `feeRecipient` | string | On-chain fee collection address. |
| `request` | object | The stored record: `status`, `expiryTime`, `biddingCloseTime`, `metadata`, … |
| `bids` | array | Bids that landed during the wait. Often `[]`. |
| `totalBuyAmount` | string | Aggregate buy-side across selected bids, base units. |

Rejections are `400` with the reason in `message` (unsupported chain, ineligible token, wallet not whitelisted for a permissioned asset, KYC required). Surface `message` — it's written for end users.

### `GET /swap/:requestId`

Status plus the top 3 bids. The only source of executable calldata.

| Field | Type | Description |
|---|---|---|
| `status` | string | `pending`, `bidding`, `ready_for_solve`, `solving`, `processing`, `finalizing`, `settling`, `filled`, `partially_filled`, `expired`, `cancelled`. |
| `bids[]` | array | Ranked best-first, max 3. |
| `totalBuyAmount` | string | Aggregate buy-side, base units. |

**Bid object**

| Field | Type | Description |
|---|---|---|
| `bidId` | string | UUID. |
| `marketMaker` / `marketMakerName` | string | Maker address and display name. |
| `makerToken` / `takerToken` | string | Buy-side / sell-side token. |
| `makerAmount` | string | What the user receives, base units. |
| `takerAmount` | string | What the user gives up, base units — **net of the protocol fee**. |
| `settlementType` | string | **`instant` or `delayed`.** Decides the accept path. |
| `estimatedSettlementTime` | integer | Seconds. `60` for instant; the real window for delayed. |
| `price` | number | Decimal-adjusted maker-per-taker rate. |
| `slippage` | number | Percent vs the oracle price. Negative is better than oracle. |
| `networkCostUSD` | number | Estimated gas cost of settling. |
| `trustScore` | number | The bidder's reputation, when available. |
| `fee` | number | Protocol fee, raw sell-token units. |
| `expiry` | integer | Unix seconds. Unfillable past this. |
| `metadata` | object | `redeemAssetData` / `redemptionAssetData` with `symbol` and `decimals`. |
| `txns[]` | array | `{ type: 'approval' \| 'execute' \| 'cancel', to, data, value? }`, **in send order**. |

### `POST /swap/:requestId/accept-delayed`

Accept a `delayed` bid. Body `{ bidId }`. Returns `{ requestId, status: 'solving', scheduleSettlementTime }`. See [Accepting a delayed bid](#accepting-a-delayed-bid).

### `POST /fill`

Record a settled instant fill. No credentials needed.

| Field | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | ✅ | The request that was filled. |
| `bidId` | string | ✅ | The bid that was accepted. |
| `txHash` | string | ✅ | Hash of the **last** transaction in `bid.txns`. |
| `filledAmount` | string | ✅ | Base units — use `bid.takerAmount`. |
| `marketMaker` | string | ✅ | `bid.marketMaker`. |

Octarine fetches the receipt and decodes its fill event, checking maker, taker, both tokens and the amount against the stored bid. A definitive mismatch is rejected; a transient RPC failure is recorded optimistically and re-verified in the background. Idempotent.

### `GET /orders/:address`

The user's requests. See [Listing a user's requests](#listing-a-users-requests).

| Param | Description |
|---|---|
| `open` | `true` returns only what the user can still act on: `pending` or `bidding`, and not past `expiryTime`. Ignored when `status` is given. |
| `status` | Comma-separated request statuses, e.g. `bidding` or `filled,expired`. Literal, not expiry-guarded. An unknown value returns `400`. |
| `chainId` | Scope to one chain. |
| `timeRange` | `all_time` (default), `last_day`, `last_week`, `last_month`, `last_year`. |
| `fullAuctionEnabled` | `true` restricts to auction-flow requests. Omit for everything. |
| `page` / `limit` | Default `1` / `20`. |

Includes requests where the address is the owner **or** the winning bidder.

### `GET /requests`

The public board — every open request, for an auction-listing view.

| Param | Description |
|---|---|
| `status` | Filter by request status. |
| `chainId` | One id, or a comma-separated list (`"98866,1"`). |
| `user` | Filter to one wallet. |
| `makerToken` / `takerToken` | Filter by either side. |
| `minAmount` / `maxAmount` | Size bounds, base units. |
| `timeRange` | As above. |
| `fullAuctionEnabled` | Restrict to auction-flow requests. |
| `page` / `limit` | Default `1` / `20`. |

Returns `{ data, page, limit, totalItems, totalPages }`. Rows carry `bidCount` and `bestBidAmount` (`"0"` when there are none), plus `fee`/`protocolFee` in raw sell-token units.

### `GET /request/:requestId`

One request record — the same row shape `GET /requests` returns.

### `GET /price/estimate`

Oracle output for a pair. Query: `chainId`, `redeemAsset`, `redemptionAsset`, `amount`. See [step 2](#2-preview-the-price).

### `GET /chains`

Supported chains and the settlement contract on each.

### `GET /tokens`

The cross-chain registry: `[{ chainId, address, symbol, name, decimals, logoURI }]`. Addresses lowercase.

### `GET /tokens/prices?chainId=`

USD prices keyed by **lowercased** address. A token with no resolvable price is omitted rather than returned as `0` — treat a missing key as unknown, not worthless.

---

## Real-time updates

A Socket.IO gateway on the `/octarine` namespace replaces most polling.

```js
import { io } from 'socket.io-client';

const socket = io('https://api.mysticfinance.xyz/octarine', { transports: ['websocket'] });

socket.emit('subscribe_request', { requestId });        // one request
socket.emit('subscribe_rfqs', { chainIds: [98866] });   // the whole board

socket.on('new_bid', ({ data }) => refreshBids(data));
socket.on('settlement_completed', ({ data }) => markDone(data));
```

| Client → server | Payload |
|---|---|
| `subscribe_rfqs` | `{ chainIds?, tokens?, marketMaker?, minAmount?, maxAmount? }` |
| `subscribe_request` | `{ requestId }` |
| `unsubscribe_rfqs` | — |
| `ping` | — (replies `pong`) |

| Server → client | Fires when |
|---|---|
| `new_rfq_request` | A request is created matching your filters. |
| `new_bid` | A bid lands on a request you're watching. |
| `bid_status_update` | A bid is accepted, rejected, expired or cancelled. |
| `rfq_status_update` | A request changes status. |
| `solving_started` | Settlement begins. |
| `settlement_completed` | The swap is done. |

An accelerator, not a source of truth — the payload has no fresh `txns`, so still re-read `GET /swap/:requestId` before executing.

---

## Supported chains

From `GET /octarine/chains`. `exchangeProxy` is the settlement contract on that chain.

| Chain | chainId | exchangeProxy |
|---|---|---|
| Plume Mainnet | `98866` | `0x900b0e037EEA342f1bEd61f239b4f4FBe839C57D` |
| Ethereum Mainnet | `1` | `0xF30fFE4E387ee7B814fA0bb093d53dcC253C63Bc` |
| Monad Mainnet | `143` | `0x1bE89a7Fc6d343272E2D1A7d91638455B8Ff767d` |
| Berachain Mainnet | `80094` | `0x438b8E1b3Dd96FaF3755Fc5f90eB8b1F5b95a97F` |
| Citrea Mainnet | `4114` | `0x441346b778C7e448817C7184ed7f6F3F486114E9` |
| Flare | `14` | `0x1f0Bd889A1d9BFeD8D908C1adBB7C45827F9218E` |
| Pharos Atlantic | `688689` | `0x9b1EE35691cC0d071F3E99a3a706dfc46667cf77` |
| Sepolia | `11155111` | `0xE067A9905fD0d5760F747329DBd6CA175a6677f2` |

Read this from the API rather than hardcoding — chains are added without a client release. An unsupported `chainId` returns `400`.

Some assets are **permissioned**: the issuer gates transfers behind a whitelist, and `POST /swap` fails with an explanatory `message` when the wallet isn't on it. Show that message verbatim.

---

## Fees

A protocol fee is taken in the **buy token** and collected on-chain to `feeRecipient` at settlement. It's already reflected in the numbers you display:

- `request.fee` (and `bid.fee`, the same value) is the fee in raw sell-token units.
- `bid.takerAmount` is the sell amount **net of** it.
- So the rate is `fee / (takerAmount + fee)` — a gross denominator.

```js
const feePct = (Number(bid.fee) / (Number(bid.takerAmount) + Number(bid.fee))) * 100;
```

Rates vary by asset and chain, so read `fee` off the response rather than hardcoding.

---

## Errors

Standard HTTP statuses with a body of:

```json
{ "statusCode": 400, "message": "Chain ID 137 is not supported…", "error": "Bad Request" }
```

**Check on the status; show the `message`.** The `message` is written to be read by end users and carries the reason.

| HTTP | Meaning | What to do |
|---|---|---|
| `400` | Validation failed, unsupported chain, ineligible token, wallet not whitelisted, KYC required, or the request/bid is in a state that forbids the action. | Read `message`. Usually the user must act, not you. |
| `404` | Unknown `requestId` or `bidId`. | Re-read the list; it may have expired and been swept. |
| `429` | Rate limited (`POST /swap` is capped at 1000/min). | Back off. Debouncing usually fixes it. |
| `500` / `502` | Upstream RPC or oracle failure. | Retry with backoff. |


Failure modes worth handling explicitly:

| Situation | Signal | Handling |
|---|---|---|
| No bids yet | `bids: []` | Not an error. The request is still live, keep polling the same `requestId`. |
| Settlement locked | `bid.txns` is `[]` | Transient. Retry in a few seconds. |
| Bid vanished mid-flight | `bidId` missing from a re-fetch | Filled elsewhere or expired. Reload and re-pick. |
| Stale calldata | The `execute` txn reverts after the approval succeeded | You cached `txns`. Re-fetch in the click handler. |
| Wrong network | Approval prompts on an unexpected chain | You didn't pin the signer to the request's `chainId`. |
