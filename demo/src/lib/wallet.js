import { ethers } from 'ethers';

export const APPROVE_ABI = ['function approve(address,uint256)'];
export const ALLOWANCE_ABI = ['function allowance(address,address) view returns (uint256)'];
export const BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

// The OctarineRFQ surface a UI needs. Settlement, the pricing view, the
// request cancel, schedule reads, the fill event and every custom error a
// fill can revert with, so a revert decodes to a reason instead of raw hex.
const ORDER =
  'tuple(address makerToken,address takerToken,uint128 takerAmount,uint128 minReceivedAmount,uint128 feeBps,address taker,address sender,address feeRecipient,uint64 expiry,uint256 salt,uint128 takerMaxBpsPerDay,uint128 makerBpsPerDay,uint128 maxMakerAmount,address maker,uint64 makerExpiry)';
const SCHEDULE =
  'tuple(uint8 mode,uint32 rollingSeconds,uint64 nextRedemptionAt,uint32 cycleSeconds,uint32 redemptionLead,uint32 maxBpsPerDay,uint64 updatedAt,bool configured)';

export const RFQ_ABI = [
  `function fillRFQOrder(${ORDER} order, bytes makerSignature, bytes takerSignature, uint128 takerAmountIn) returns (uint256 makerAmount, uint256 fee)`,
  `function quoteRFQOrder(${ORDER} order, uint128 takerAmountIn) view returns (uint256 makerAmount, uint256 fee, uint32 horizonSeconds)`,
  'function cancelSalt(address account, uint256 salt)',
  'function saltCancelled(address account, uint256 salt) view returns (bool)',
  'function secondsToRedemption(address asset) view returns (uint32)',
  `function scheduleOf(address asset) view returns (${SCHEDULE})`,
  'function halted(address asset) view returns (bool)',
  'function paused() view returns (bool)',

  'event RFQOrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint128 takerAmountFilled, uint256 makerAmount, uint256 fee, uint32 horizonSeconds, uint128 makerBpsPerDay)',
  'event SaltCancelled(address indexed account, uint256 indexed salt)',

  'error ZeroAddress()',
  'error ZeroAmount()',
  'error ScheduleNotConfigured(address asset)',
  'error BpsPerDayTooHigh(uint128 bpsPerDay, uint32 maxBpsPerDay)',
  'error BpsPerDayAboveTakerCap(uint128 bpsPerDay, uint128 takerMaxBpsPerDay)',
  'error DiscountExceedsPrincipal(uint256 discountBps)',
  'error NoPriceAvailable(address base, address quote)',
  'error AssetHalted(address asset)',
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
  'error EnforcedPause()',
  'error SafeERC20FailedOperation(address token)',
];

export const rfqInterface = new ethers.Interface(RFQ_ABI);

const ORDER_KEYS = [
  'makerToken', 'takerToken', 'takerAmount', 'minReceivedAmount', 'feeBps', 'taker', 'sender',
  'feeRecipient', 'expiry', 'salt', 'takerMaxBpsPerDay', 'makerBpsPerDay', 'maxMakerAmount', 'maker',
  'makerExpiry',
];

// Our own Error type for an RFQ revert, so the UI can branch on `.rfqError`
// (the contract's error name) rather than string-matching a message.
export class RfqError extends Error {
  constructor(name, args, message) {
    super(message);
    this.rfqError = name;
    this.args = args;
  }
}

export async function connectWallet() {
  if (!window.ethereum) throw new Error('No wallet found. Install MetaMask.');
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();
  return {
    account: await signer.getAddress(),
    chainId: Number((await provider.getNetwork()).chainId),
  };
}

// Request signatures and bid calldata are built for one chain. The wallet
// won't always be on it, so switch first, then check again before we hand
// back a signer.
export async function signerOn(chainId) {
  if (!window.ethereum) throw new Error('No wallet found. Install MetaMask.');

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
  return provider.getSigner();
}

// Read-only RPC per chain, so reads don't depend on which network the wallet
// happens to be on. Add an entry when you add a chain.
const RPC = {
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
};

const EXPLORER = {
  11155111: 'https://sepolia.etherscan.io',
};

export function txUrl(chainId, hash) {
  const base = EXPLORER[chainId];
  return base && hash ? `${base}/tx/${hash}` : null;
}

export function readProvider(chainId) {
  const url = RPC[chainId];
  if (url) return new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
  return window.ethereum ? new ethers.BrowserProvider(window.ethereum) : null;
}

// Reads the balance on `chainId` itself, not on the wallet's current network.
// Reading through the wallet meant the number vanished whenever the two
// disagreed, since balanceOf against an address with no contract on it comes
// back as empty data and ethers raises BAD_DATA.
export async function readBalance(tokenAddress, owner, chainId) {
  const provider = readProvider(chainId);
  if (!provider) return null;
  return new ethers.Contract(tokenAddress, BALANCE_ABI, provider).balanceOf(owner);
}

/**
 * Which tokens the RFQ on this chain will buy, and how far each is from
 * redemption. Read straight off the contract because it is what prices the
 * fill: an asset with no configured schedule reverts ScheduleNotConfigured, a
 * halted one AssetHalted, so neither belongs in a "You sell" list.
 *
 * Returns { [lowercased address]: { mode, horizonSeconds, maxBpsPerDay, halted } }
 * for listed assets only. maxBpsPerDay is human bps/day (the contract stores x100).
 */
export async function readSchedules(rfq, addresses, chainId) {
  const provider = readProvider(chainId);
  if (!rfq || !provider) return {};
  const contract = new ethers.Contract(rfq, RFQ_ABI, provider);

  const rows = await Promise.allSettled(
    addresses.map(async (address) => {
      const s = await contract.scheduleOf(address);
      if (!s.configured) return null;
      const [seconds, halted] = await Promise.all([
        contract.secondsToRedemption(address),
        contract.halted(address).catch(() => false),
      ]);
      return [
        address.toLowerCase(),
        {
          mode: Number(s.mode) === 1 ? 'CYCLICAL' : 'ROLLING',
          horizonSeconds: Number(seconds),
          maxBpsPerDay: Number(s.maxBpsPerDay) / 100,
          nextRedemptionAt: Number(s.nextRedemptionAt) || null,
          halted,
        },
      ];
    }),
  );

  return Object.fromEntries(
    rows.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value),
  );
}

/**
 * Sign the request returned by POST /swap. This is the user's consent to the
 * trade: pair, amount, minimum proceeds, fee, rate cap and deadline. Check the
 * parts a wrong payload could get wrong before the wallet ever sees it.
 */
export async function signRequest(typedData, chainId, { rfq, account } = {}) {
  const { domain, types, message } = typedData || {};
  if (!domain || !types?.Request || !message) throw new Error('POST /swap returned no typedData to sign.');
  if (domain.name !== 'OctarineRFQ') throw new Error(`Unexpected EIP-712 domain "${domain.name}".`);
  if (Number(domain.chainId) !== Number(chainId)) {
    throw new Error(`Request is for chain ${domain.chainId}, not ${chainId}.`);
  }
  if (rfq && domain.verifyingContract.toLowerCase() !== rfq.toLowerCase()) {
    throw new Error('Request names a different settlement contract than GET /chains. Not signing.');
  }
  if (Number(message.orderType) !== 0) throw new Error('Expected an RFQ request (orderType 0).');
  if (account && message.taker.toLowerCase() !== account.toLowerCase()) {
    throw new Error('Request is for a different wallet.');
  }

  const signer = await signerOn(Number(chainId));
  // ethers derives the domain type itself and rejects one passed in `types`.
  const { EIP712Domain, ...rest } = types; // eslint-disable-line no-unused-vars
  return signer.signTypedData(domain, rest, message);
}

const REQUEST_TYPES = {
  Request: [
    { name: 'makerToken', type: 'address' },
    { name: 'takerToken', type: 'address' },
    { name: 'takerAmount', type: 'uint128' },
    { name: 'minReceivedAmount', type: 'uint128' },
    { name: 'feeBps', type: 'uint128' },
    { name: 'taker', type: 'address' },
    { name: 'sender', type: 'address' },
    { name: 'feeRecipient', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'salt', type: 'uint256' },
    { name: 'takerMaxBpsPerDay', type: 'uint128' },
    { name: 'orderType', type: 'uint8' },
  ],
};

/**
 * Rebuild the typed data for a request you only have the stored row for
 * (My auctions, after a reload). `template` is the row's metadata.rfqOrder,
 * whose request fields are exactly what the user signs; orderType is 0 (RFQ).
 */
export function requestTypedData(template, chainId, rfq) {
  const message = Object.fromEntries(
    REQUEST_TYPES.Request.map(({ name }) => [name, name === 'orderType' ? 0 : String(template[name])]),
  );
  return {
    domain: { name: 'OctarineRFQ', version: '1', chainId: Number(chainId), verifyingContract: rfq },
    types: REQUEST_TYPES,
    primaryType: 'Request',
    message,
  };
}

// The fillRFQOrder call inside a bid's txns, decoded. Null for a bid that
// settles through a bundle (a Safe execTransaction), which we can't price
// locally; those are simulated as-is.
export function decodeFill(bid) {
  const tx = (bid.txns || []).find((t) => !t.type?.toLowerCase().includes('approv'));
  if (!tx) return null;
  let parsed;
  try {
    parsed = rfqInterface.parseTransaction({ data: tx.data, value: tx.value || 0 });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== 'fillRFQOrder') return null;
  const [order, makerSignature, takerSignature, takerAmountIn] = parsed.args;
  return {
    rfq: tx.to,
    order: Object.fromEntries(ORDER_KEYS.map((k) => [k, order[k]])),
    makerSignature,
    takerSignature,
    takerAmountIn: BigInt(takerAmountIn),
  };
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Price a bid right now with quoteRFQOrder, the same view the fill uses.
 * The bid's quotedNet is a snapshot; the oracle and (for cyclical assets) the
 * horizon both move, so re-quote before asking the user to sign anything.
 *
 * Returns null when the bid isn't a direct fill. Throws RfqError when the
 * order can't fill at all (rate over a cap, no price, halted...).
 */
export async function quoteBid(bid, chainId) {
  const fill = decodeFill(bid);
  if (!fill) return null;

  const contract = new ethers.Contract(fill.rfq, RFQ_ABI, readProvider(chainId));
  let makerAmount, fee, horizonSeconds;
  try {
    [makerAmount, fee, horizonSeconds] = await contract.quoteRFQOrder(fill.order, fill.takerAmountIn);
  } catch (e) {
    throw toRfqError(e);
  }

  const { order, takerAmountIn } = fill;
  const takerAmount = BigInt(order.takerAmount);
  const received = makerAmount - fee;
  // Both bounds are for the whole order and apply pro-rata; the floor rounds up.
  const floor = ceilDiv(BigInt(order.minReceivedAmount) * takerAmountIn, takerAmount);
  const cap = (BigInt(order.maxMakerAmount) * takerAmountIn) / takerAmount;

  return {
    ...fill,
    makerAmount,
    fee,
    received,
    horizonSeconds: Number(horizonSeconds),
    floor,
    cap,
    belowFloor: received < floor,
    overCap: makerAmount > cap,
  };
}

/**
 * Sends bid.txns in order: the approval to the RFQ contract (skipped when the
 * allowance already covers it), then fillRFQOrder. The fill is simulated with
 * provider.call first, so a revert surfaces as a named reason before the user
 * pays gas for it.
 *
 * Returns { txHash, filled }, where `filled` is the RFQOrderFilled event from
 * the receipt (the actual amounts) or null when no fill was sent, which is
 * the normal case for a delayed bid.
 */
export async function executeBid(bid, chainId, owner, onStep = () => {}) {
  const signer = await signerOn(chainId);
  let txHash = '';
  let filled = null;

  for (const tx of bid.txns) {
    const isApproval = tx.type?.toLowerCase().includes('approv');
    const request = { to: tx.to, data: tx.data, value: tx.value || undefined, from: owner };

    if (isApproval) {
      // Don't re-prompt if the allowance already covers it. Some tokens also
      // revert going from one non-zero allowance straight to another.
      const [spender, needed] = new ethers.Interface(APPROVE_ABI).decodeFunctionData('approve', tx.data);
      const token = new ethers.Contract(tx.to, ALLOWANCE_ABI, signer);
      if ((await token.allowance(owner, spender)) >= BigInt(needed)) continue;
      onStep('Approve in wallet');
    } else {
      onStep('Checking fill');
      try {
        await signer.provider.call(request);
      } catch (e) {
        throw toRfqError(e);
      }
      onStep('Confirm in wallet');
    }

    let receipt;
    try {
      const sent = await signer.sendTransaction(request);
      onStep(isApproval ? 'Approving' : 'Settling');
      receipt = await sent.wait();
      txHash = sent.hash;
    } catch (e) {
      throw toRfqError(e);
    }
    if (!isApproval) filled = parseFill(receipt) || filled;
  }

  return { txHash, filled };
}

// The RFQOrderFilled event, as numbers the UI can use. The event carries no
// token addresses; join them from the bid.
export function parseFill(receipt) {
  for (const log of receipt?.logs || []) {
    let parsed = null;
    try {
      parsed = rfqInterface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== 'RFQOrderFilled') continue;
    const a = parsed.args;
    return {
      rfq: log.address,
      orderHash: a.orderHash,
      maker: a.maker,
      taker: a.taker,
      takerAmountFilled: a.takerAmountFilled,
      makerAmount: a.makerAmount,
      fee: a.fee,
      received: a.makerAmount - a.fee,
      horizonSeconds: Number(a.horizonSeconds),
      makerBpsPerDay: Number(a.makerBpsPerDay) / 100,
    };
  }
  return null;
}

/**
 * Cancel a signed request on-chain: cancelSalt(user, salt). Pass the cancelTx
 * DELETE /request/:id returned, or the rfq + salt to build it here. Either
 * way the user sends it; the backend sees SaltCancelled and closes the row.
 */
export async function cancelRequest({ chainId, account, cancelTx, rfq, salt, onStep = () => {} }) {
  let to = cancelTx?.to;
  let data = cancelTx?.data;
  if (!to || !data) {
    if (!rfq || salt == null) throw new Error('Nothing to cancel on-chain: no salt for this request.');
    to = rfq;
    data = rfqInterface.encodeFunctionData('cancelSalt', [account, salt]);
  }
  if (rfq && to.toLowerCase() !== rfq.toLowerCase()) {
    throw new Error('Cancel transaction targets an unexpected contract.');
  }

  const signer = await signerOn(chainId);
  onStep('Confirm in wallet');
  try {
    const sent = await signer.sendTransaction({ to, data });
    onStep('Cancelling');
    await sent.wait();
    return sent.hash;
  } catch (e) {
    throw toRfqError(e);
  }
}

// --- revert decoding -------------------------------------------------------

const MESSAGES = {
  OrderExpired: 'The request or this bid has expired. Pick another bid or create a new request.',
  SaltIsCancelled: 'This request was cancelled on-chain.',
  OrderIsCancelled: 'The bidder withdrew this bid. Pick another one.',
  InvalidSignature: 'A signature did not verify. Sign the request again, or pick another bid.',
  WrongSender: 'This order can only be submitted by its named sender.',
  OrderOverfilled: 'This bid has already been filled.',
  MakerAmountTooHigh: "The price moved past the bidder's limit. Pick another bid.",
  ReceivedBelowMinimum: 'The payout would fall below the minimum you signed. Nothing was sold.',
  ZeroMinReceived: 'The request has no minimum payout.',
  NothingDelivered: 'The token transfer delivered nothing.',
  FeeBpsOutOfBounds: 'The fee is outside what the contract allows.',
  SameToken: 'You cannot sell a token for itself.',
  BpsPerDayTooHigh: "The bid's rate is above this asset's maximum.",
  BpsPerDayAboveTakerCap: "The bid's rate is above the maximum rate you signed.",
  DiscountExceedsPrincipal: 'At this horizon the rate would discount the whole trade.',
  ScheduleNotConfigured: 'This asset is not listed on the Octarine RFQ.',
  NoPriceAvailable: 'No live oracle price for this pair right now. Try again shortly.',
  AssetHalted: 'Trading in this asset is halted.',
  EnforcedPause: 'Octarine RFQ is paused.',
  ZeroAmount: 'Zero amount.',
  ZeroAddress: 'The order has an empty address in it.',
  SafeERC20FailedOperation: 'A token transfer failed. Check your balance and approval.',
};

function revertData(e) {
  const seen = new Set();
  const stack = [e];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== 'object' || seen.has(x)) continue;
    seen.add(x);
    if (typeof x.data === 'string' && /^0x[0-9a-f]{8}/i.test(x.data)) return x.data;
    stack.push(x.data, x.error, x.info, x.info?.error, x.cause);
  }
  return null;
}

// Any thrown wallet/RPC error -> RfqError with a readable message when it is
// one of ours, the original error otherwise. User rejections pass through.
export function toRfqError(e) {
  if (e instanceof RfqError) return e;
  if (e?.code === 'ACTION_REJECTED' || e?.code === 4001) return new Error('Rejected in wallet.');
  const data = revertData(e);
  if (data) {
    let parsed = null;
    try {
      parsed = rfqInterface.parseError(data);
    } catch {
      // selector matched but the args didn't decode; fall through
    }
    if (parsed) {
      return new RfqError(parsed.name, parsed.args, MESSAGES[parsed.name] || parsed.name);
    }
  }
  return e instanceof Error ? e : new Error(String(e?.message || e));
}
