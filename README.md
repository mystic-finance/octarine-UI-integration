# Octarine

Octarine is an RFQ venue for exiting tokenised real-world assets (RWAs) into stablecoins. A user publishes a *request*, "sell 1,000 mRWA for USDC", signs it, and bidders compete on it by quoting a **rate**: how many basis points per day they discount the asset by for the time left until it redeems. The user accepts the bid they want and settles it on-chain against Octarine's audited `OctarineRFQ` contract, which works out the payout from the oracle price and the redemption horizon at the moment of the fill. The user never receives less than the minimum they signed.

| | |
|---|---|
| **Production** | `https://api.mysticfinance.xyz` |
| **Staging** | `https://staging-api.mysticfinance.xyz` (same API, safe to experiment against) |
| **All routes below** | prefixed `/octarine` |
| **Interactive API docs** | [Swagger](https://api.mysticfinance.xyz/docs) ([staging](https://staging-api.mysticfinance.xyz/docs)) |
| **Live demo** | [demo.octarine.finance](https://demo.octarine.finance/), source in [`demo/`](demo) |
| **Support** | [joao.moreira@mysticfinance.xyz](mailto:joao.moreira@mysticfinance.xyz) |

---

## Contents

- [How it works](#how-it-works)
- [Authentication](#authentication)
- [Quickstart](#quickstart)
- [Signing the request](#signing-the-request)
- [Instant vs delayed settlement](#instant-vs-delayed-settlement)
- [Cancelling](#cancelling)
- [Fees](#fees)
- [Listing a user's requests](#listing-a-users-requests)
- [Conventions](#conventions)
- [Pitfalls](#pitfalls)
- [API reference](#api-reference)
- [Supported chains](#supported-chains)
- [Real-time updates](#real-time-updates)
- [Errors](#errors)
- [Migrating from v1](#migrating-from-v1)

---

## How it works

```
  1. CREATE           2. SIGN             3. BID              4. ACCEPT              5. SETTLED
  ┌────────────┐   ┌──────────────┐   ┌───────────────┐   ┌─────────────────┐   ┌────────────────┐
  │ Sell X RWA │   │ User signs   │   │ Bidders quote │   │ approve the RFQ │   │ Paid from the  │
  │ for a      │──▶│ the request  │──▶│ a rate in     │──▶│ + fillRFQOrder  │──▶│ oracle price & │
  │ stablecoin │   │ (EIP-712)    │   │ bps/day       │   │                 │   │ horizon, ≥ min │
  └────────────┘   └──────────────┘   └───────────────┘   └─────────────────┘   └────────────────┘
   POST /swap       POST /swap/         GET /swap/:id        bid.txns              POST /fill
   → typedData      signature           → bids[]
```

1. **Create.** The user picks an RFQ-listed RWA and the stablecoin they want, and enters an amount. `POST /swap` creates the request and returns its terms as EIP-712 typed data: the pair, the amount, the **minimum the user will receive**, the **maximum rate** they'll accept, the fee and a deadline.
2. **Sign.** The user signs those terms in their wallet. The signature is their consent to the trade; nothing can settle without it.
3. **Bid.** Bidders quote a rate (`makerBpsPerDay`, e.g. `2.5` bps/day) instead of an amount. You read the bids from `GET /swap/:requestId`, ranked lowest rate first (= most money for the user), each with a quoted payout.
4. **Accept.** The user sends the bid's `txns`: an approval of the RWA to the RFQ contract, then `fillRFQOrder`. The RWA goes straight from the user to the bidder, and the stablecoin straight from the bidder to the user.
5. **Settled.** The contract prices the fill at that moment, `payout = oracle value × (1 − rate × time to redemption) − fee`, and reverts if that would be below the signed minimum. The actual amounts are in the `RFQOrderFilled` event, which `POST /fill` also returns.

A **request** is the user's intent, keyed by `requestId` (a UUID). A **bid** is a bidder's signed offer against it, keyed by `bidId`. Funds never leave the user's wallet until the fill executes.

**What can be traded.** Only RWAs the RFQ lists (they have a redemption schedule on the contract), and only *for* stablecoins. Buying an RWA, stable→stable, or an unlisted asset is rejected at `POST /swap`. Escrowed settlement, Dutch auctions and cross-chain fills are not available through this API.

---

## Authentication

**The user flow needs no API key.** Loading tokens, estimating a price, creating a request, reading bids, accepting, and recording a fill are all open.

What protects the user is their **request signature**: an EIP-712 signature over the exact terms (pair, amount, minimum payout, fee, rate cap, deadline). The contract checks it on every fill that the user doesn't send themselves, and a bidder that alters any of those terms invalidates it. Signing is consent; sending the fill transaction yourself is consent too.

`DELETE /octarine/request/:requestId` is gated on an origin allowlist that defaults to deny. That only affects the off-chain bookkeeping: the user can always cancel on-chain themselves with `cancelSalt`. See [Cancelling](#cancelling).

---

## Quickstart

```js
const BASE = 'https://staging-api.mysticfinance.xyz/octarine';
```

The samples use [ethers v6](https://docs.ethers.org/v6/).

### 1. Load chains, tokens and what can be sold

```js
const { data: chains } = await (await fetch(`${BASE}/chains`)).json();
// [{ chainId: 11155111, name: 'Sepolia', rfq: '0x…', supported: true }, …]
const { rfq } = chains.find((c) => c.chainId === chainId);

const tokens = (await (await fetch(`${BASE}/tokens`)).json()).filter((t) => t.chainId === chainId);
// [{ chainId, address, symbol, name, decimals, logoURI, isStable }, …]
```

`rfq` is the `OctarineRFQ` contract on that chain: the `verifyingContract` the user signs for, and the spender they approve. Read it from `/chains`; don't hard-code it.

**What the user can sell** is every RWA the RFQ has a redemption schedule for. Read it from the contract, which is also what prices the fill:

```js
import { ethers } from 'ethers';

const RFQ_ABI = [
  'function scheduleOf(address) view returns (tuple(uint8 mode,uint32 rollingSeconds,uint64 nextRedemptionAt,uint32 cycleSeconds,uint32 redemptionLead,uint32 maxBpsPerDay,uint64 updatedAt,bool configured))',
  'function secondsToRedemption(address) view returns (uint32)',
  'function halted(address) view returns (bool)',
];
const contract = new ethers.Contract(rfq, RFQ_ABI, provider);

const stables = tokens.filter((t) => t.isStable);
const sellable = [];
for (const t of tokens.filter((t) => !t.isStable)) {
  const s = await contract.scheduleOf(t.address);
  if (!s.configured || (await contract.halted(t.address))) continue;
  sellable.push({
    ...t,
    mode: Number(s.mode) === 1 ? 'CYCLICAL' : 'ROLLING',
    horizonSeconds: Number(await contract.secondsToRedemption(t.address)), // time to redemption
    maxBpsPerDay: Number(s.maxBpsPerDay) / 100,                            // highest rate any bid may use
  });
}
```

| Schedule mode | What the horizon does |
|---|---|
| `ROLLING` | Constant: always `T+N`. A 2.5 bps/day bid on a 30-day asset is always a 0.75% discount. |
| `CYCLICAL` | Counts down, to the second, to a calendar redemption date, then rolls to the next one. The same bid is worth more as redemption approaches. |

`GET /tokens/redemption-times?chainId=` gives the same horizons pre-formatted as `T+N` strings, keyed by lowercased address, if you only need a label.

### 2. Preview the price

```js
const q = new URLSearchParams({ chainId, redeemAsset: SELL, redemptionAsset: BUY, amount: '1000000000' });
const { data } = await (await fetch(`${BASE}/price/estimate?${q}`)).json();
```

```json
{
  "price": 1.02,
  "inputAmount": "1000000000",
  "outputAmount": "1020000000",
  "redeemAssetInfo": { "decimals": 6, "priceUSD": 1.02 },
  "redemptionAssetInfo": { "decimals": 6, "priceUSD": 1 }
}
```

This is the **oracle value** of what the user sells, not a tradeable quote: no bidder has committed to it. What the user actually receives is that value less the bid's discount over the horizon, less the fee (see [the formula](#the-payout-formula)). With the horizon from step 1 you can show a realistic range before a request exists: the best case is a low rate, the worst case is the asset's `maxBpsPerDay`.

### 3. Create the request

```js
const res = await fetch(`${BASE}/swap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chainId,
    walletAddress: userAddress,
    redeemAsset: SELL,          // an RFQ-listed RWA
    redemptionAsset: BUY,       // a stablecoin
    amount: '1000000000',       // base units
    expiry: 1440,               // bidding window, minutes
    slippageTolerance: 1,       // percent; sets the signed terms unless you send them yourself
    swapType: 'direct',
    fullAuctionEnabled: true,
    // optional, instead of deriving them from slippage:
    // minReceivedAmount: '1000000000',   // stable base units, the user's floor
    // takerMaxBpsPerDay: 4,              // human bps/day, the user's rate cap
  }),
});
if (!res.ok) throw new Error((await res.json()).message);
const request = await res.json();
```

```json
{
  "type": "rfq",
  "requestId": "7f80e8a4-5c0e-4feb-8b45-c6f4fa385c6d",
  "message": "RFQ created — sign typedData and POST it to /swap/signature",
  "feeBps": 15,
  "feeRecipient": "0x0D4e1E488308f2B06f1AdED77170D56BD44CDbF2",
  "requestHash": "0x3b1c…9e07",
  "signatureRequired": true,
  "typedData": { "domain": { "…": "…" }, "types": { "…": "…" }, "primaryType": "Request", "message": { "…": "…" } },
  "request": { "status": "pending", "expiryTime": 1792000000, "…": "…" },
  "bids": []
}
```

When you don't send `minReceivedAmount` / `takerMaxBpsPerDay`, Octarine derives them from `slippageTolerance` and the asset's horizon: the rate cap is the rate that slippage implies over the horizon plus a 25% buffer, and the floor sits 25 bps under the payout at that cap. Either way, the values that bind are the ones in `typedData.message`. Show them to the user.

Keep `requestId`. It is the handle for everything downstream.

### 4. Sign the request

```js
const signer = await provider.getSigner();
const { domain, types, message } = request.typedData;
const { EIP712Domain, ...signTypes } = types;   // ethers builds the domain type itself
const signature = await signer.signTypedData(domain, signTypes, message);

await fetch(`${BASE}/swap/signature`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requestId: request.requestId, signature }),
});
```

Bidders can see and bid on the request before it is signed, but no bid can settle until the signature is attached. You can also send the signature inline as `takerSignature` on `POST /swap` if you build the typed data yourself. The full payload is in [Signing the request](#signing-the-request).

### 5. Read the bids

```js
const { status, bids, signatureRequired } = await (await fetch(`${BASE}/swap/${requestId}`)).json();
```

```json
{
  "status": "bidding",
  "signatureRequired": false,
  "bids": [
    {
      "bidId": "dbf43493-dbe4-4c15-9f13-19d37497d9ac",
      "status": "pending",
      "marketMaker": "0x346298209c3accdf53d56b624cee10b56ca308de",
      "marketMakerName": "Test Provider3",
      "makerToken": "0x754704bc059f8c67012fed69bc8a327a5aafb603",
      "takerToken": "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
      "takerAmount": "1000000000",
      "makerBpsPerDay": 2.5,
      "maxMakerAmount": "1032597000",
      "makerExpiry": 1791381413,
      "horizonSeconds": 2592000,
      "quotedMakerAmount": "1012350000",
      "quotedFee": "1518525",
      "quotedNet": "1010831475",
      "quotedAt": 1791380000,
      "feeBps": 15,
      "settlementType": "instant",
      "estimatedSettlementTime": 60,
      "trustScore": 87,
      "networkCostUSD": 0.04,
      "metadata": { "redeemAssetData": { "decimals": 6, "symbol": "mRWA" },
                    "redemptionAssetData": { "decimals": 6, "symbol": "USDC" } },
      "txns": [
        { "type": "approval", "to": "0x3bd3…433a", "data": "0x095ea7b3…" },
        { "type": "execute",  "to": "<rfq>",      "data": "0x…" }
      ]
    }
  ]
}
```

Bids come back **ranked lowest `makerBpsPerDay` first**, which is the most money for the user. `quotedNet` is what the user would receive if the fill landed at `quotedAt`; show it as **"You receive (quote)"**, next to the floor the user signed, **"at least …"**.

#### The payout formula

A bid is a rate; the amount is computed on-chain when the fill lands:

```
gross       = takerAmountIn × oraclePrice / 1e18          (priceOf(takerToken, makerToken))
makerAmount = gross × (D − rate × horizonSeconds) / D      D = 10_000 × 100 × 86_400
fee         = makerAmount × feeBps / 10_000
received    = makerAmount − fee                            reverts if < minReceivedAmount (pro-rata)
```

`rate` here is the contract unit, `makerBpsPerDay × 100` (2.5 bps/day = `250`). Worked through for the bid above: 1,000 mRWA at 1.02 = 1,020 USDC gross; 2.5 bps/day over 30 days is a 75 bps discount, so `makerAmount` = 1,012.35; a 15 bps fee is 1.518525; the user receives **1,010.831475 USDC**.

```js
const D = 10_000n * 100n * 86_400n;
function expectedReceived(gross, bpsPerDay, horizonSeconds, feeBps) {
  const makerAmount = (gross * (D - BigInt(Math.round(bpsPerDay * 100)) * BigInt(horizonSeconds))) / D;
  const fee = (makerAmount * BigInt(feeBps)) / 10_000n;
  return makerAmount - fee;
}
```

The bid also carries the bidder's own bound, `maxMakerAmount`: if the oracle price rises so far that the payout would exceed it, the fill reverts (`MakerAmountTooHigh`) and the user should pick another bid.

#### Re-quoting on-chain (optional)

`quotedNet` is a snapshot. To price a bid **now**, call the contract's `quoteRFQOrder` view with the order inside the bid's `execute` transaction. It is the exact function the fill uses:

```js
const RFQ = new ethers.Interface([
  'function fillRFQOrder(tuple(address makerToken,address takerToken,uint128 takerAmount,uint128 minReceivedAmount,uint128 feeBps,address taker,address sender,address feeRecipient,uint64 expiry,uint256 salt,uint128 takerMaxBpsPerDay,uint128 makerBpsPerDay,uint128 maxMakerAmount,address maker,uint64 makerExpiry) order, bytes makerSignature, bytes takerSignature, uint128 takerAmountIn) returns (uint256, uint256)',
  'function quoteRFQOrder(tuple(address makerToken,address takerToken,uint128 takerAmount,uint128 minReceivedAmount,uint128 feeBps,address taker,address sender,address feeRecipient,uint64 expiry,uint256 salt,uint128 takerMaxBpsPerDay,uint128 makerBpsPerDay,uint128 maxMakerAmount,address maker,uint64 makerExpiry) order, uint128 takerAmountIn) view returns (uint256 makerAmount, uint256 fee, uint32 horizonSeconds)',
]);

const exec = bid.txns.find((t) => t.type === 'execute');
const { args } = RFQ.parseTransaction({ data: exec.data });   // [order, makerSig, takerSig, takerAmountIn]
const [makerAmount, fee, horizonSeconds] = await new ethers.Contract(exec.to, RFQ, provider)
  .quoteRFQOrder(args[0], args[3]);
const received = makerAmount - fee;
```

#### Polling

Sometimes it takes a while to get bids. An empty `bids` array means nobody has bid *yet*; keep polling the same `requestId`. How long you poll is a UI decision. A short `expiry` request usually wants a tight loop and a fallback; a long one wants no loop at all: persist the `requestId`, list it from `GET /orders/:address`, and re-check `GET /swap/:requestId` when the user opens it. Or skip polling and subscribe to [`new_bid`](#real-time-updates).

```js
async function waitForBids(requestId, { attempts = 15, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { bids } = await (await fetch(`${BASE}/swap/${requestId}`)).json();
    if (bids.length) return bids;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return [];   // still live: poll again later, or let the user come back to it
}
```

Bids can *disappear* between polls. Each bid has its own `makerExpiry`, and only bids that are still pending, unexpired and still quotable within both parties' bounds are returned.

**Read `settlementType` on every bid before you do anything with it.** See [Instant vs delayed settlement](#instant-vs-delayed-settlement).

### 6. Accept

Re-read the bid inside the click handler, check it hasn't lapsed, then send its `txns` in order. For a direct fill that is `[approval, execute]`: an `approve` of the RWA to the RFQ contract for `takerAmount`, then `fillRFQOrder(order, makerSignature, '0x', takerAmountIn)`. The user sends the fill themselves, so their taker signature isn't needed in the call (sending is consent).

Simulate the fill before sending it. A revert then comes back as a named error, before the user pays gas.

```js
async function executeBid(bid, chainId, owner) {
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
  if (bid.makerExpiry <= Date.now() / 1000 + 60) throw new Error('Bid about to expire, pick another.');

  let receipt;
  for (const tx of bid.txns) {
    const req = { to: tx.to, data: tx.data, value: tx.value || undefined, from: owner };
    if (tx.type === 'approval') {
      const [spender, needed] = new ethers.Interface(['function approve(address,uint256)'])
        .decodeFunctionData('approve', tx.data);
      const erc20 = new ethers.Contract(tx.to, ['function allowance(address,address) view returns (uint256)'], signer);
      if ((await erc20.allowance(owner, spender)) >= needed) continue;
    } else {
      try {
        await provider.call(req);                       // static call first
      } catch (e) {
        const decoded = e.data && RFQ_ERRORS.parseError(e.data);   // RFQ_ERRORS: see "On-chain errors"
        throw new Error(decoded ? decoded.name : e.shortMessage || e.message);
      }
    }
    receipt = await (await signer.sendTransaction(req)).wait();
  }
  return receipt;   // the execute receipt
}
```

The actual amounts are in the `RFQOrderFilled` event on the receipt:

```js
const EVENTS = new ethers.Interface([
  'event RFQOrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint128 takerAmountFilled, uint256 makerAmount, uint256 fee, uint32 horizonSeconds, uint128 makerBpsPerDay)',
]);
const filled = receipt.logs.map((l) => { try { return EVENTS.parseLog(l); } catch { return null; } })
  .find((l) => l?.name === 'RFQOrderFilled');
const received = filled.args.makerAmount - filled.args.fee;   // stable base units, ≥ the signed floor
```

The event carries no token addresses; join them from the bid.

### 7. Record the fill (instant only)

```js
const res = await fetch(`${BASE}/fill`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    requestId,
    bidId: bid.bidId,
    txHash: receipt.hash,
    marketMaker: bid.marketMaker,
    filledAmount: filled.args.takerAmountFilled.toString(),
  }),
});
const { data } = await res.json();
// { takerAmountFilled, makerAmount, fee, receivedAmount, horizonSeconds, makerBpsPerDay, … }
```

The swap already happened on-chain; this closes the loop. Octarine re-reads `RFQOrderFilled` from the receipt, checks it against the stored bid, marks the request filled and returns the actual amounts from the event. It is idempotent, so a failed call can be retried; Octarine also picks fills up from the chain on its own.

---

## Signing the request

`typedData` from `POST /swap` is a complete [EIP-712](https://eips.ethereum.org/EIPS/eip-712) payload. Annotated:

```js
{
  domain: {
    name: 'OctarineRFQ',
    version: '1',
    chainId: 11155111,                       // the request's chain
    verifyingContract: '0x…',                // `rfq` from GET /chains
  },
  primaryType: 'Request',
  types: {
    Request: [
      { name: 'makerToken',        type: 'address' },
      { name: 'takerToken',        type: 'address' },
      { name: 'takerAmount',       type: 'uint128' },
      { name: 'minReceivedAmount', type: 'uint128' },
      { name: 'feeBps',            type: 'uint128' },
      { name: 'taker',             type: 'address' },
      { name: 'sender',            type: 'address' },
      { name: 'feeRecipient',      type: 'address' },
      { name: 'expiry',            type: 'uint64'  },
      { name: 'salt',              type: 'uint256' },
      { name: 'takerMaxBpsPerDay', type: 'uint128' },
      { name: 'orderType',         type: 'uint8'   },
    ],
  },
  message: {
    makerToken: '0x754704bc059f8c67012fed69bc8a327a5aafb603',   // what the user receives (stablecoin)
    takerToken: '0x3bd359c1119da7da1d913d1c4d2b7c461115433a',   // what the user sells (RFQ-listed RWA)
    takerAmount: '1000000000',                                   // 1,000 mRWA, base units
    minReceivedAmount: '1003214618',                             // floor on proceeds, stable base units, after fee
    feeBps: '15',                                                // 0.15% of the bidder's payment
    taker: '0xUser…',                                            // the user's wallet
    sender: '0x0000000000000000000000000000000000000000',        // anyone may submit the fill
    feeRecipient: '0x0D4e1E488308f2B06f1AdED77170D56BD44CDbF2',  // Octarine
    expiry: '1792000000',                                        // unix seconds; nothing settles after this
    salt: '84129645239371926183747726938129437612934871269348712693487126934871269348712',
    takerMaxBpsPerDay: '417',                                    // 4.17 bps/day (contract units ×100)
    orderType: 0,                                                // 0 = RFQ, always
  },
}
```

| Field | What the user is agreeing to |
|---|---|
| `takerToken`, `takerAmount` | Sell up to this much of this RWA. A bid may fill part of it. |
| `makerToken` | Be paid in this stablecoin. |
| `minReceivedAmount` | Never receive less than this for the whole amount, after the fee. Enforced pro-rata, rounded up, on every fill. Never zero. |
| `takerMaxBpsPerDay` | Never accept a bid above this rate. Contract units: hundredths of a bp per day. |
| `feeBps`, `feeRecipient` | The fee, taken out of the bidder's payment. See [Fees](#fees). |
| `expiry` | The request's deadline. Must cover any delayed bid's settlement. |
| `salt` | Unique per request. It is also the cancel handle: `cancelSalt(user, salt)`. |
| `sender` | Who may submit the fill. `0x0…0` = anyone holding both signatures. |
| `orderType` | Always `0` (RFQ, paid on fill). |

Sign with `signer.signTypedData(domain, types, message)` in ethers v6 (`_signTypedData` in v5), or `eth_signTypedData_v4` directly. Strip `EIP712Domain` from `types` if it is present; ethers adds it itself and rejects a duplicate. Smart-contract wallets (EIP-1271) work too.

Before you ask the user to sign, check that `domain.chainId` is the request's chain, `domain.verifyingContract` is the chain's `rfq`, and `message.taker` is the connected wallet. The demo's `signRequest` refuses otherwise.

**Keep the signature private.** Send it only to `POST /swap/signature`. Octarine never shows it to bidders until a winner is chosen, because anyone holding it could pair their own bid with it. A leaked signature can cost the user price improvement, never principal: no fill can go below `minReceivedAmount` or above `takerMaxBpsPerDay`.

---

## Instant vs delayed settlement

Every bid carries `settlementType`, chosen by the bidder: `instant` or `delayed`. An instant bid settles the moment the user sends the fill. A delayed bid settles later, once the bidder funds it; Octarine submits the fill itself using the user's stored request signature, so the user approves and then tells Octarine which delayed bid they picked.

|  | **`settlementType: "instant"`** | **`settlementType: "delayed"`** |
|---|---|---|
| What the bidder is saying | "I have the funds now" | "I'll settle within a window" |
| `estimatedSettlementTime` | `60` (around one minute) | The real window, set by the bidder (e.g. 24h) |
| `bid.txns` holds | approval + `fillRFQOrder` | the approval only, so Octarine can fill later |
| How you accept | Send `bid.txns`, then `POST /fill` | Send `bid.txns`, then `POST /swap/:requestId/accept-delayed` with `{ "bidId": "..." }` |
| Who sends `fillRFQOrder` | The user | Octarine, with the user's request signature |
| Request status after | `filled` | `solving` while Octarine settles, then `filled` |

The user's signed bounds hold either way: a delayed fill still pays at least `minReceivedAmount` (pro-rata), at a rate no higher than `takerMaxBpsPerDay`. The amount itself is priced when the fill lands, not when the user approves, so show the delayed payout as a quote and the floor as the guarantee. A delayed bid's `makerExpiry` is later than its settlement deadline, and the request `expiry` covers it. If the bidder never funds, the bid lapses; while the request is still before `expiry` it can be re-auctioned under the same signature, otherwise the user creates a new one.

> `POST /swap/:requestId/accept-delayed` locks in the delayed bid the user chose and moves the request to `solving`. Without it Octarine does not know which delayed bid to settle. The backend rejects it if the bid's `makerExpiry` or the request `expiry` would lapse before the settlement deadline.

---

## Cancelling

A signed request stays settleable until its `expiry` unless it is cancelled **on-chain**: the signature is out there, and Octarine needs it to settle delayed bids. Cancel with the RFQ's `cancelSalt(account, salt)`, where `account` is the user's address and `salt` is the request's salt. That voids every unfilled order made against that request, and only the user (or a signer they registered) can call it.

```js
// Off-chain: close the request and get the transaction (origin-allowlisted; may 403)
const res = await fetch(`${BASE}/request/${requestId}`, { method: 'DELETE' });
const { cancelTx } = await res.json();          // { to: rfq, data: cancelSalt(user, salt) }

// Or build it yourself, always available:
const data = new ethers.Interface(['function cancelSalt(address account, uint256 salt)'])
  .encodeFunctionData('cancelSalt', [userAddress, typedData.message.salt]);

await (await signer.sendTransaction({ to: rfq, data })).wait();
```

Octarine watches for `SaltCancelled` and closes the request even if the `DELETE` was refused. An **unsigned** request can never settle, so for one of those the `DELETE` (or just letting it expire) is enough.

Cancellation is a transaction: it can't stop a fill that is already in the mempool. The signed floor still holds for that fill.

---

## Fees

The fee is a single number in the signed request, **`feeBps`**, set by Octarine at creation:

```
feeBps = Octarine's per-asset rate (bps/day) × horizon in days  +  referralFeeBps
         clamped to the contract's [minFeeBps, maxFeeBps]
```

It is taken out of the bidder's payment, in the stablecoin: `fee = makerAmount × feeBps / 10_000`, sent to `feeRecipient`, and the user receives the rest. So it comes off the user's proceeds, which is why the user signs it. `minReceivedAmount` is already net of the fee. Each bid reports its fee in stable units as `quotedFee`; the fill's actual fee is `fee` in `RFQOrderFilled`.

There is no fee in the sell token any more, and `takerAmount` is not reduced by anything: the user delivers exactly the RWA amount the bid fills.

### Referral fees

If you're the distribution channel, you can charge for it. Pass an address you control as `referral` and the commission you want as `referralFeeBps` on `POST /swap`, and Octarine pays you out of the settlement:

```js
body: JSON.stringify({
  chainId, walletAddress, redeemAsset, redemptionAsset, amount,
  referral: '0xYourVenueWallet',
  referralFeeBps: 25,            // 0.25% of the payout
}),
```

- **It is additive.** It is added to `feeBps`, so it comes out of the **user's payout**, not out of Octarine's cut. Show it to them; it is in the terms they sign.
- **It is flat, not per-day.** Octarine's own part scales with the horizon; a distribution commission does not.
- **It is per request**, set at creation and fixed for that trade. There is no account to register; the address is the identity.
- **It is capped**, at 100 bps (1%) by default. Above that the request is rejected at creation.

The fee lands with Octarine's `feeRecipient` and your share is paid out in the same distribution as the protocol's, so nothing extra is required from you. A `referralFeeBps` of `0` (or omitted) records no referral; sending `referralFeeBps` **without** `referral` is a `400`.

---

## Listing a user's requests

`GET /orders/:address` returns every request the address is party to, newest first, with the best live bid embedded per open row. Use it for a "my auctions" view and to recover requests after a reload.

```js
const q = new URLSearchParams({ chainId, open: 'true', limit: 20 });
const { data } = await (await fetch(`${BASE}/orders/${userAddress}?${q}`)).json();
const rows = data.transactions.data;
```

Each row is a summary:
- `requestId`, `chainId`, `status`, `expiryTime`;
- `sellToken` / `buyToken`, with human-scaled amounts and symbols;
- `bid`, the best pending bid, with `makerBpsPerDay` and `quotedNet`;
- `txHash` once filled.

**The signed terms are not on the row.** For an open row you want to sign or cancel, read the full record with [`GET /request/:requestId`](#get-requestrequestid). It carries:
- `signatureRequired`;
- `requestHash`;
- `salt`;
- `rfqContract`;
- `rfqOrder`, every signed request field, also at `metadata.rfqOrder`.

Show a row with `signatureRequired: true` as **awaiting signature** and offer to sign it. Rebuild the typed data from `rfqOrder` with `orderType: 0`, or re-read it from the `POST /swap` response if you kept it. The demo's `MyAuctions.jsx` does exactly this.

```js
const open = rows.filter((r) => ['pending', 'bidding'].includes(r.status) && r.expiryTime > Date.now() / 1000);
const details = await Promise.all(open.map((r) => fetch(`${BASE}/request/${r.requestId}`).then((x) => x.json())));
```

---

## Conventions

**Amounts are integers in the token's smallest unit, as decimal strings.** `100 USDC` (6 decimals) is `"100000000"`, never `100`, never `"100.0"`. Get `decimals` from `GET /octarine/tokens`.

**Rates are human bps/day in the API** (`makerBpsPerDay: 2.5`, `maxBpsPerDay: 30`) **and ×100 on-chain** (`250`, `3000`). The typed data and the contract use the on-chain unit: `takerMaxBpsPerDay: '417'` is 4.17 bps/day.

**Horizons are seconds** (`horizonSeconds`), the time until the RWA redeems, as the contract measures it.

**The naming is redemption-flavoured.** Requests and bids describe the same two tokens with different words:

| Request field | Order / bid field | Meaning |
|---|---|---|
| `redeemAsset` | `takerToken` | The RWA being **sold** |
| `redemptionAsset` | `makerToken` | The stablecoin being **received** |
| `amount` / `redeemAmount` | `takerAmount` | Sell size, base units |
| — | `quotedNet` | What the user would receive now, stable base units |
| — | `minReceivedAmount` | The least the user will receive, signed |

The user is the **taker**; the bidder is the **maker**.

**Timestamps are unix seconds** (`expiryTime`, `makerExpiry`, `typedData.message.expiry`), except `createdAt`/`updatedAt`, which are ISO 8601.

---

## Pitfalls

**Never cache `txns` or a bid.** Re-fetch `GET /swap/:requestId` inside the click handler. Bids lapse at `makerExpiry`, get withdrawn, or get re-ranked, and a stale one fails *after* the user has paid for the approval. Check `makerExpiry` with a margin before you start.

**Simulate before you send.** `provider.call` the `execute` transaction first and decode the revert. A fill that would revert `MakerAmountTooHigh` or `ReceivedBelowMinimum` should never reach the wallet.

**The payout drifts.** The oracle price moves, and for a `CYCLICAL` asset the horizon shrinks by the second, so the same bid pays a little more each minute. Label `quotedNet` as a quote, show the signed minimum as "at least", re-quote with `quoteRFQOrder` before the user signs anything, and show the **actual** amount from `RFQOrderFilled` afterwards.

**Cyclical schedules jump.** A `CYCLICAL` asset's horizon counts down to its redemption date, then, at the issuer's cut-off before that date, jumps to the *next* cycle (roughly a month longer). A bid quoted just before the jump is worth noticeably less just after it. Don't show a horizon or a quote you read more than a few minutes ago, and expect a fill near the roll to come back below the old quote (still above the floor).

**Settle on the request's chain**, never the wallet's current network. The typed data is bound to one `chainId` and one `rfq`; a signature or fill on another chain fails `InvalidSignature`. Switch the wallet to the request's chain before signing and before sending, and check `domain.chainId` / `domain.verifyingContract` before signing.

**Keep the request signature confidential.** Post it to `/swap/signature` only. Don't log it, store it client-side, or put it in a URL.

**Approve the RFQ, not anything else.** The approval spender is the chain's `rfq`. Approve exactly `takerAmount`; there is no standing approval to set up.

**An unsigned request is not live.** Bids can arrive, but nothing settles until the signature is attached. If the user closes the wallet prompt, offer to sign again rather than creating a second request.

**Only listed RWAs, only for stablecoins.** Don't offer a token the RFQ has no schedule for, a halted one, or a non-stable as the payout; `POST /swap` rejects them.

---

## API reference

All routes prefixed `/octarine`.

### `POST /swap`

Create a request. Blocks up to ~3s so an already-standing bidder can answer inline.

| Field | Type | Required | Description |
|---|---|---|---|
| `walletAddress` | string | ✅ | The user's wallet. Becomes the request's `taker`. |
| `redeemAsset` | string | ✅ | RWA being **sold**. Must be listed on the chain's RFQ. |
| `redemptionAsset` | string | ✅ | Stablecoin being **received**. |
| `amount` | string | ✅ | Sell size, base units. |
| `chainId` | integer | ✅ | Must be supported and have an `rfq`. |
| `expiry` | integer | — | Bidding window in **minutes**. Default `15`. |
| `slippageTolerance` | number | — | Percent. Default `1`. Sets the signed rate cap and floor when you don't send them. |
| `minReceivedAmount` | string | — | The user's floor on proceeds, stable base units, after fee. Must be non-zero. |
| `takerMaxBpsPerDay` | number | — | The user's rate cap, human bps/day. At most the asset's `maxBpsPerDay`. |
| `takerSignature` | string | — | The request signature, if you built and signed the typed data yourself. Otherwise use `POST /swap/signature`. |
| `swapType` | string | — | `direct` (default: the user sends the fill) or `system` (Octarine submits it). |
| `fullAuctionEnabled` | boolean | — | Marks it as an auction. Default `false`. |
| `referral` | string | — | Address to credit with a commission. See [Referral fees](#referral-fees). |
| `referralFeeBps` | integer | — | That commission, bps. Capped at **100** by default. |

**Response**

| Field | Type | Description |
|---|---|---|
| `type` | string | `rfq`. |
| `requestId` | string | UUID. |
| `message` | string | Human-readable state. |
| `typedData` | object | The EIP-712 `Request` to sign. See [Signing the request](#signing-the-request). |
| `requestHash` | string | Its EIP-712 digest (`hashRequest`). |
| `signatureRequired` | boolean | `true` until the signature is attached. |
| `feeBps` | integer | The fee in the signed terms. |
| `feeRecipient` | string | Where the fee is paid. |
| `request` | object | The stored record: `status`, `expiryTime`, `biddingCloseTime`, `metadata` (`rfqOrder` template, `rfqContract`, `minReceivedAmount`, `feeBps`, `horizonSeconds`, `maxBpsPerDay`), … Never the signature. |
| `bids` | array | Bids that landed during the wait. Often `[]`. |

Rejections are `400` with the reason in `message`: unsupported chain, no RFQ on the chain, asset not listed on the RFQ (or halted), payout token not a stablecoin, wallet not whitelisted for a permissioned asset, KYC required. Surface `message`; it's written for end users.

### `POST /swap/signature`

Attach the user's request signature. Body `{ requestId, signature }`, `signature` as `0x` hex (65-byte ECDSA, or EIP-1271 bytes for a contract wallet). Verified against `requestHash` and the request's `taker`; a wrong signer is a `400`. Idempotent for the same signature; a different one for an already-signed request is rejected.

### `GET /swap/:requestId`

Status plus the best bids. The only source of executable calldata.

| Field | Type | Description |
|---|---|---|
| `status` | string | `pending`, `bidding`, `ready_for_solve`, `solving`, `processing`, `finalizing`, `settling`, `filled`, `partially_filled`, `expired`, `cancelled`. |
| `signatureRequired` | boolean | `true` while the request is **awaiting signature**: bids may be listed, but none can settle. |
| `requestHash` | string | What to sign, if you sign the digest rather than the typed data. |
| `bids[]` | array | Ranked lowest `makerBpsPerDay` first. |

**Bid object**

| Field | Type | Description |
|---|---|---|
| `bidId` | string | UUID. |
| `status` | string | `pending` (live), `accepted`, `rejected`, `expired`, `cancelled`. Only `pending` bids are returned here. |
| `marketMaker` / `marketMakerName` | string | Bidder address and display name. |
| `makerToken` / `takerToken` | string | Stablecoin paid / RWA bought. |
| `takerAmount` | string | RWA this bid fills, base units. Can be less than the request (partial). |
| `makerBpsPerDay` | number | **The bid.** Human bps/day. |
| `maxMakerAmount` | string | The bidder's ceiling on its payment for the whole request, stable base units. |
| `makerExpiry` | integer | Unix seconds. The bid can't fill after this. |
| `horizonSeconds` | integer | Time to redemption the quote was priced over. |
| `quotedMakerAmount` / `quotedFee` / `quotedNet` | string | The quote at `quotedAt`: bidder pays / fee / user receives, stable base units. |
| `quotedAt` | integer | Unix seconds. |
| `feeBps` | integer | The request's fee. |
| `settlementType` | string | **`instant` or `delayed`.** Decides the accept path. |
| `estimatedSettlementTime` | integer | Seconds. `60` for instant; the bidder's window for delayed. |
| `networkCostUSD` | number | Estimated gas cost of settling. |
| `trustScore` | number | The bidder's reputation, when available. |
| `metadata` | object | `redeemAssetData` / `redemptionAssetData` with `symbol` and `decimals`. |
| `txns[]` | array | `{ type: 'approval' \| 'execute', to, data, value? }`, **in send order**. `execute` is `fillRFQOrder` on the `rfq` for a direct fill; a few special bidders settle through a bundled transaction instead. |

### `POST /fill`

Record a settled instant fill. No credentials needed.

| Field | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | ✅ | The request that was filled. |
| `bidId` | string | ✅ | The bid that was accepted. |
| `txHash` | string | ✅ | Hash of the `execute` transaction. |
| `marketMaker` | string | ✅ | `bid.marketMaker`. |
| `filledAmount` | string | ✅ | `takerAmountFilled` from `RFQOrderFilled`, base units. |

Octarine fetches the receipt, decodes `RFQOrderFilled` and checks it against the stored bid (order hash, maker, taker, amount). It responds with the **actual** amounts: `takerAmountFilled`, `makerAmount`, `fee`, `receivedAmount` (`makerAmount − fee`), `horizonSeconds`, `makerBpsPerDay`. A definitive mismatch is rejected; a transient RPC failure is recorded optimistically and re-verified in the background. Idempotent.

### `DELETE /request/:requestId`

Close a request off-chain. Returns `{ cancelTx: { to, data } }`, the `cancelSalt(user, salt)` transaction for the user to send. Origin-allowlisted. See [Cancelling](#cancelling).

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

The public board: every open request, for an auction-listing view.

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

Returns `{ data, page, limit, totalItems, totalPages }`. Rows carry `bidCount`, the best bid, and the request's public terms (`minReceivedAmount`, `feeBps`, `horizonSeconds`, `maxBpsPerDay`). Never a signature.

### `GET /request/:requestId`

One request record, the same row shape `GET /requests` returns. It is not wrapped in `data`.

For a v2 request it includes the public signed terms: `requestHash`, `signatureRequired`, `salt`, `rfqContract`, `minReceivedAmount`, `takerMaxBpsPerDay`, `feeBps`, and `rfqOrder` (also at `metadata.rfqOrder`). It never includes the signature.

A v1 request has **no `requestHash`**. That is how to recognise one; see [Migrating from v1](#migrating-from-v1).

### `GET /price/estimate`

Oracle value of a pair. Query: `chainId`, `redeemAsset`, `redemptionAsset`, `amount`. See [step 2](#2-preview-the-price).

### `GET /chains`

Supported chains and the `rfq` (`OctarineRFQ`) contract on each.

### `GET /tokens`

The cross-chain registry: `[{ chainId, address, symbol, name, decimals, logoURI, isStable }]`. Addresses lowercase. `isStable` marks what a request can be paid in. Which non-stable tokens can be sold is on the RFQ itself: `scheduleOf(asset).configured`, see [step 1](#1-load-chains-tokens-and-what-can-be-sold).

### `GET /tokens/redemption-times?chainId=`

Time to redemption per token as a `T+N` label, keyed by lowercased address. Tokens with no schedule are omitted.

### `GET /tokens/prices?chainId=`

USD prices keyed by **lowercased** address. A token with no resolvable price is omitted rather than returned as `0`; treat a missing key as unknown, not worthless.

---

## Supported chains

From `GET /octarine/chains`. `rfq` is the `OctarineRFQ` contract on that chain: the EIP-712 `verifyingContract`, the approval spender, and the `cancelSalt` target.

| Chain | chainId | rfq |
|---|---|---|
| Sepolia (staging) | `11155111` | from `GET /chains` |
| Plume Mainnet | `98866` | from `GET /chains` |
| Ethereum Mainnet | `1` | from `GET /chains` |
| Monad Mainnet | `143` | from `GET /chains` |
| Berachain Mainnet | `80094` | from `GET /chains` |
| Citrea Mainnet | `4114` | from `GET /chains` |
| Flare | `14` | from `GET /chains` |
| Pharos Atlantic | `688689` | from `GET /chains` |

The RFQ is rolling out chain by chain; a chain whose entry has no `rfq` can't take requests yet. Always read the address at runtime rather than copying it from here.

Some assets are **permissioned**: the issuer gates transfers behind a whitelist, and `POST /swap` fails with an explanatory `message` when the wallet isn't on it.

---

## Real-time updates

A Socket.IO gateway on the `/octarine` namespace replaces most polling.

```js
import { io } from 'socket.io-client';

const socket = io('https://staging-api.mysticfinance.xyz/octarine', { transports: ['websocket'] });

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
| `new_rfq_request` | A request is created matching your filters. Carries the public terms, never the signature. |
| `new_bid` | A bid lands on a request you're watching. Carries `makerBpsPerDay`, `makerExpiry` and the quote; re-read `GET /swap/:requestId` for `txns`. |
| `bid_status_update` | A bid is accepted, rejected, expired or cancelled. |
| `rfq_status_update` | A request changes status (including cancelled on-chain). |
| `solving_started` | Settlement begins (a delayed bid is being filled). |
| `settlement_completed` | The swap is done. |

---

## Errors

### HTTP

Standard HTTP statuses with a body of:

```json
{ "statusCode": 400, "message": "Chain ID 137 is not supported…", "error": "Bad Request" }
```

**Check the status; show the `message`.** It is written to be read by end users and carries the reason.

| HTTP | Meaning | What to do |
|---|---|---|
| `400` | Validation failed, unsupported chain, asset not listed on the RFQ, non-stable payout, wallet not whitelisted, KYC required, bad signature, or the request/bid is in a state that forbids the action. | Read `message`. Usually the user must act, not you. |
| `403` | `DELETE /request` from an origin that isn't allowlisted. | Cancel on-chain with `cancelSalt` instead. |
| `404` | Unknown `requestId` or `bidId`. | Re-read the list; it may have expired and been swept. |
| `429` | Rate limited (`POST /swap` is capped at 1000/min). | Back off. Debouncing usually fixes it. |
| `500` / `502` | Upstream RPC or oracle failure. | Retry with backoff. |

Failure modes worth handling explicitly:

| Situation | Signal | Handling |
|---|---|---|
| No bids yet | `bids: []` | Not an error. The request is still live; keep polling the same `requestId`. |
| Awaiting signature | `signatureRequired: true` | Ask the user to sign; don't create a second request. |
| Bid vanished mid-flight | `bidId` missing from a re-fetch | Filled, withdrawn or expired. Reload and re-pick. |
| Bid about to lapse | `makerExpiry` within a minute | Pick another bid. |
| Wrong network | Wallet prompts on an unexpected chain | Pin the signer to the request's `chainId` before signing and sending. |

### On-chain errors

`OctarineRFQ` reverts with custom errors. Decode the revert data from a simulation or a failed transaction with the contract interface and map it:

```js
const RFQ_ERRORS = new ethers.Interface([
  'error OrderExpired(uint64 expiry)',
  'error SaltIsCancelled(address account, uint256 salt)',
  'error OrderIsCancelled(bytes32 orderHash)',
  'error InvalidSignature()',
  'error WrongSender(address expected, address actual)',
  'error OrderOverfilled(uint128 requested, uint128 remaining)',
  'error MakerAmountTooHigh(uint256 makerAmount, uint256 cap)',
  'error ReceivedBelowMinimum(uint256 received, uint256 floor_)',
  'error ZeroMinReceived()',
  'error NothingDelivered()',
  'error FeeBpsOutOfBounds(uint128 feeBps, uint128 minFeeBps, uint128 maxFeeBps)',
  'error SameToken()',
  'error BpsPerDayTooHigh(uint128 bpsPerDay, uint32 maxBpsPerDay)',
  'error BpsPerDayAboveTakerCap(uint128 bpsPerDay, uint128 takerMaxBpsPerDay)',
  'error DiscountExceedsPrincipal(uint256 discountBps)',
  'error ScheduleNotConfigured(address asset)',
  'error NoPriceAvailable(address base, address quote)',
  'error AssetHalted(address asset)',
  'error EnforcedPause()',
]);

const err = RFQ_ERRORS.parseError(revertData);   // null if it isn't one of these
// err.name === 'ReceivedBelowMinimum', err.args.received, err.args.floor_
```

| Error | Meaning | What to tell the user / do |
|---|---|---|
| `OrderExpired(expiry)` | The request's `expiry` or the bid's `makerExpiry` has passed. | Pick another bid; if the request itself expired, create a new one. |
| `SaltIsCancelled(account, salt)` | The request was cancelled with `cancelSalt`. | It's closed. Create a new request. |
| `OrderIsCancelled(orderHash)` | The bidder withdrew this bid (`cancelOrder`). | Pick another bid. |
| `InvalidSignature()` | The bid's or the request's signature didn't verify: wrong chain or contract, altered terms, or no request signature on a fill the user didn't send. | Re-sign the request on the right chain; or pick another bid. |
| `WrongSender(expected, actual)` | The order names a `sender` and someone else submitted it. | Submit from the named sender. |
| `OrderOverfilled(requested, remaining)` | This bid, or the user's request, is already (partly) filled. | Reload; pick another bid for the rest. |
| `MakerAmountTooHigh(makerAmount, cap)` | The price rose past the bidder's `maxMakerAmount`. | Pick another bid. |
| `ReceivedBelowMinimum(received, floor)` | The payout would be below the user's signed `minReceivedAmount`. Nothing is sold. | Pick another bid, or wait for the price to recover. |
| `ZeroMinReceived()` | The request has a zero floor. | Recreate it; Octarine never builds one. |
| `FeeBpsOutOfBounds(feeBps, min, max)` | The fee is outside the contract's bounds. | Recreate the request. Report it to Octarine. |
| `SameToken()` | Selling a token for itself. | Pick a different payout token. |
| `BpsPerDayTooHigh(rate, max)` | The bid's rate is above the asset's `maxBpsPerDay`. | Pick another bid. |
| `BpsPerDayAboveTakerCap(rate, cap)` | The bid's rate is above the user's `takerMaxBpsPerDay`. | Pick another bid. |
| `DiscountExceedsPrincipal(discountBps)` | Rate × horizon would discount the whole amount. | Pick another bid. |
| `ScheduleNotConfigured(asset)` | The RWA isn't listed on the RFQ. | Don't offer it. |
| `NoPriceAvailable(base, quote)` | No healthy oracle price for the pair right now. | Retry shortly. |
| `AssetHalted(asset)` | Trading in this asset is halted. | Try later; hide it from the sell list. |
| `EnforcedPause()` | The RFQ is paused. | Try later. |

`NothingDelivered()` (the RWA transfer moved nothing) and ERC-20 failures such as an insufficient allowance or balance can also surface; show them as "the token transfer failed, check balance and approval".

---

## Migrating from v1

v2 settles on a new contract, `OctarineRFQ`. If you integrated v1, the flow is the same: create a request, read bids, accept, record the fill. Below is what changes in that flow, and what your users have left on v1 to clean up. The demo's `/migrate` page does the clean-up; see [Clean up v1](#clean-up-v1).

### What changes

| | v1 | v2 |
|---|---|---|
| Settlement contract | `exchangeProxy` from `GET /chains` | `rfq` from `GET /chains`. `exchangeProxy` is no longer returned |
| After `POST /swap` | Nothing; the request was live | **New step:** the user signs `typedData` and you `POST /swap/signature`. Bids can arrive before that, but nothing settles until it lands. See [step 4](#4-sign-the-request) |
| What can be sold | Any listed pair | RFQ-listed RWAs, for stablecoins only. Filter on `isStable` from `GET /tokens` and `scheduleOf(asset).configured` on the RFQ. See [step 1](#1-load-chains-tokens-and-what-can-be-sold) |
| What a bid is | An amount: `makerAmount`, `price`, `slippage` | A rate: `makerBpsPerDay`. The payout is computed when the fill lands. See [the payout formula](#the-payout-formula) |
| What to show the user | `makerAmount` | `quotedNet` as "You receive (quote)", and the signed `minReceivedAmount` as "at least" |
| Ranking | Best first, top 3 | Lowest `makerBpsPerDay` first, which is the most money for the user |
| Bid expiry | `expiry` | `makerExpiry` |
| Approval spender | `exchangeProxy` | `rfq` |
| `execute` transaction | A bundled settlement call | `fillRFQOrder` on `rfq`. Simulate it first; reverts decode to [named errors](#on-chain-errors) |
| `POST /fill` → `filledAmount` | `bid.takerAmount` | `takerAmountFilled` from the `RFQOrderFilled` event. The response returns the actual amounts paid |
| Fee | `fee` in sell-token units; `takerAmount` already net of it | `feeBps`, taken from the stablecoin proceeds; per-bid `quotedFee`. The user delivers exactly `takerAmount`. See [Fees](#fees) |
| Cancelling | `DELETE /request/:id` | The same call now also returns `cancelTx`. Once the request is signed, the user must send it to stop a fill. See [Cancelling](#cancelling) |
| Delayed bids | Approve, then `accept-delayed` | Same calls, but the request must be signed: Octarine fills with the user's request signature |
| User's own bounds | `slippageTolerance` | Still accepted. It now sets the signed `minReceivedAmount` and `takerMaxBpsPerDay`, which you can also send directly |
| `new_bid` WebSocket payload | `makerAmount` | `makerBpsPerDay`, `makerExpiry` and the quote |

Unchanged: the base URLs, the `/octarine` prefix, no API key for the user flow, `GET /swap/:requestId` as the only source of `txns`, `accept-delayed`, `GET /orders/:address`, the WebSocket rooms, and the HTTP error format.

### Clean up v1

A user who traded on v1 can have two things left there.

**Approvals to the v1 contract.** Nothing uses them any more. Offer to revoke each one, `approve(v1Contract, 0)`. Find them by reading `allowance(user, v1Contract)` for each token on the chain:

| Chain | chainId | v1 contract |
|---|---|---|
| Ethereum Mainnet | `1` | `0xF30fFE4E387ee7B814fA0bb093d53dcC253C63Bc` |
| Flare | `14` | `0x1f0Bd889A1d9BFeD8D908C1adBB7C45827F9218E` |
| Monad Mainnet | `143` | `0x1bE89a7Fc6d343272E2D1A7d91638455B8Ff767d` |
| Citrea Mainnet | `4114` | `0x441346b778C7e448817C7184ed7f6F3F486114E9` |
| Berachain Mainnet | `80094` | `0x438b8E1b3Dd96FaF3755Fc5f90eB8b1F5b95a97F` |
| Plume Mainnet | `98866` | `0x900b0e037EEA342f1bEd61f239b4f4FBe839C57D` |
| Plume Testnet | `98867` | `0x056A1cD35FB1b9D48553A7C5dAB46Ee939AA5164` |
| Pharos Atlantic | `688689` | `0x9b1EE35691cC0d071F3E99a3a706dfc46667cf77` |
| Sepolia | `11155111` | `0xE067A9905fD0d5760F747329DBd6CA175a6677f2` |

**Open v1 requests.** They were built for the v1 contract, so no v2 bid can settle them. Find them in `GET /orders/:address?open=true`, then read each with `GET /request/:requestId`: a v1 request has no `requestHash`. Close it with `DELETE /request/:requestId`; if your origin isn't allowlisted, it simply expires. Nothing on v2 can fill it, and revoking the v1 approval for its token (above) stops it from ever filling on v1. Then let the user sell again with a new request.

```js
const V1_CONTRACT = { 11155111: '0xE067A9905fD0d5760F747329DBd6CA175a6677f2' /* … */ };

// approvals to revoke
const erc20 = (a) => new ethers.Contract(a, ['function allowance(address,address) view returns (uint256)'], provider);
const leftover = [];
for (const t of tokens) {
  if ((await erc20(t.address).allowance(user, V1_CONTRACT[chainId])) > 0n) leftover.push(t);
}

// open v1 requests
const { data } = await (await fetch(`${BASE}/orders/${user}?chainId=${chainId}&open=true&limit=50`)).json();
const v1Requests = [];
for (const row of data.transactions.data) {
  const r = await (await fetch(`${BASE}/request/${row.requestId}`)).json();
  if (!r.requestHash && !r.metadata?.requestHash) v1Requests.push(row);
}
```

In the demo:
- `src/lib/legacy.js` holds these reads and the revoke;
- `src/components/LegacyMigration.jsx` is the `/migrate` page, plus a banner that appears on the other pages while anything is left;
- `MyAuctions.jsx` labels v1 rows instead of offering to sign or cancel them.
