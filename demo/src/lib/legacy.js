import { ethers } from 'ethers';
import { ALLOWANCE_ABI, APPROVE_ABI, readProvider, signerOn, toRfqError } from './wallet';

// Migration helpers: what a wallet still holds from the Octarine v1
// integration, which settled on a different contract than OctarineRFQ (v2).
//
// Two things can be left behind:
//   1. ERC-20 approvals to the v1 settlement contract. Nothing uses them any
//      more, so the user should revoke them.
//   2. Requests created on v1. They were built for the v1 contract, so no bid
//      on the v2 RFQ can settle them. Close them, and sell again with a new
//      request.

// The v1 settlement contract on each chain. GET /chains no longer returns
// it, so it is listed here, for clean-up only. Never use it
// to sign or approve anything new: that is the chain's `rfq`.
export const V1_CONTRACT = {
  1: '0xF30fFE4E387ee7B814fA0bb093d53dcC253C63Bc',
  14: '0x1f0Bd889A1d9BFeD8D908C1adBB7C45827F9218E',
  143: '0x1bE89a7Fc6d343272E2D1A7d91638455B8Ff767d',
  4114: '0x441346b778C7e448817C7184ed7f6F3F486114E9',
  80094: '0x438b8E1b3Dd96FaF3755Fc5f90eB8b1F5b95a97F',
  98866: '0x900b0e037EEA342f1bEd61f239b4f4FBe839C57D',
  98867: '0x056A1cD35FB1b9D48553A7C5dAB46Ee939AA5164',
  688689: '0x9b1EE35691cC0d071F3E99a3a706dfc46667cf77',
  11155111: '0xE067A9905fD0d5760F747329DBd6CA175a6677f2',
};

const OPEN = new Set(['pending', 'bidding']);

// A request is from v1 when GET /request/:id has no
// requestHash: every OctarineRFQ request has one (the EIP-712 digest the user
// signs), and a v1 request never did.
export function isLegacyRequest(detail) {
  return !!detail && !detail.requestHash && !detail.metadata?.requestHash;
}

// Still open, so still shown to the user as live, but unsettleable now.
export function isOpenRow(row, nowSec = Date.now() / 1000) {
  return OPEN.has(row.status) && !row.txHash && (row.expiryTime || 0) > nowSec;
}

/**
 * Non-zero allowances `owner` still gives the v1 contract, one per token.
 * Returns [{ token, allowance }] with allowance as a bigint. Reads on `chainId`
 * itself, not on the wallet's current network.
 */
export async function readLegacyAllowances(tokens, owner, chainId) {
  const spender = V1_CONTRACT[chainId];
  const provider = readProvider(chainId);
  if (!spender || !provider || !owner) return [];

  const rows = await Promise.all(
    tokens.map(async (token) => {
      try {
        const allowance = await new ethers.Contract(token.address, ALLOWANCE_ABI, provider).allowance(owner, spender);
        return allowance > 0n ? { token, allowance } : null;
      } catch {
        return null; // not an ERC-20 on this chain, or the RPC blinked
      }
    }),
  );
  return rows.filter(Boolean);
}

/** approve(v1 contract, 0). Returns the transaction hash. */
export async function revokeLegacyApproval(tokenAddress, chainId, onStep = () => {}) {
  const spender = V1_CONTRACT[chainId];
  if (!spender) throw new Error('Octarine v1 was never deployed on this chain.');
  const signer = await signerOn(chainId);
  const data = new ethers.Interface(APPROVE_ABI).encodeFunctionData('approve', [spender, 0n]);
  onStep('Confirm in wallet');
  try {
    const sent = await signer.sendTransaction({ to: tokenAddress, data });
    onStep('Revoking');
    await sent.wait();
    return sent.hash;
  } catch (e) {
    throw toRfqError(e);
  }
}

/**
 * The user's open v1 requests. Lists open rows from
 * GET /orders/:address, then reads each one's full record (GET /request/:id),
 * which is where requestHash lives.
 */
export async function readLegacyRequests(oct, owner, chainId) {
  if (!owner) return [];
  const r = await oct.myOrders(owner, { chainId, open: true, limit: 50 });
  const rows = (r?.data?.transactions?.data || []).filter((row) => isOpenRow(row));
  const details = await Promise.all(rows.map((row) => oct.request(row.requestId).catch(() => null)));
  return rows.filter((_, i) => isLegacyRequest(details[i]));
}
