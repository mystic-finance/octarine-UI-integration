import { ethers } from 'ethers';
import { toRfqError } from './wallet';

// Base units -> number. Never throws, a bad value just reads as 0.
export function fmt(raw, decimals = 18) {
  try {
    return Number(ethers.formatUnits(BigInt(raw ?? 0), Number(decimals) || 18));
  } catch {
    return 0;
  }
}

export function n(v, maxFrac = 4) {
  const x = Number(v);
  return Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: maxFrac }) : '—';
}

export const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '—');

export function countdown(s) {
  if (s <= 0) return 'Expired';
  if (s > 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s > 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Unix seconds -> local date/time.
export const when = (unix) => (unix ? new Date(Number(unix) * 1000).toLocaleString() : '—');

// bid.estimatedSettlementTime is seconds: 60 for instant, the real window for delayed.
export function settlementTime(bid) {
  const s = bid.estimatedSettlementTime || 0;
  if (bid.settlementType !== 'delayed') return s > 90 ? `~${Math.round(s / 60)} minutes` : '~1 minute';
  const hours = Math.round(s / 3600);
  if (!hours) return 'Later today';
  return hours >= 24 ? `~${Math.round(hours / 24)} days` : `~${hours} hours`;
}

// --- rates -----------------------------------------------------------------
//
// A bid is a RATE, not an amount: makerBpsPerDay, charged over the seconds
// until the asset redeems. The API speaks human bps/day (2.5); the contract
// stores it x100 (250). The payout is computed on-chain at fill:
//
//   makerAmount = gross * (D - rate * horizonSeconds) / D,  D = 10_000 * 100 * 86_400
//   fee         = makerAmount * feeBps / 10_000
//   received    = makerAmount - fee        (never below the signed minimum)

export const BPS_PER_DAY_SCALE = 100;
export const DAY = 86_400;
export const DISCOUNT_DENOMINATOR = 10_000n * 100n * 86_400n;

export const toContractRate = (human) => Math.round(Number(human) * BPS_PER_DAY_SCALE);
export const toHumanRate = (contract) => Number(contract) / BPS_PER_DAY_SCALE;

// 2.5 -> "2.5 bps/day"
export function rate(bpsPerDay) {
  const x = Number(bpsPerDay);
  if (!Number.isFinite(x)) return '—';
  return `${Math.round(x * 100) / 100} bps/day`;
}

// Seconds to redemption -> "30d", "14d 6h", "5h 20m", "12m".
export function horizon(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!s) return '—';
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

// Total discount a rate takes over a horizon, in bps: 2.5 bps/day over 30d = 75.
export function discountBps(bpsPerDay, horizonSeconds) {
  return (Number(bpsPerDay) * Number(horizonSeconds)) / DAY;
}

export const pct = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;

/**
 * What the user receives for `gross` (the oracle value of what they sell, in
 * the stable's base units) at a human rate over a horizon, after the fee.
 * BigInt all the way, same rounding as the contract.
 */
export function expectedReceived(gross, bpsPerDay, horizonSeconds, feeBps) {
  const discount = BigInt(toContractRate(bpsPerDay)) * BigInt(Math.max(1, Math.floor(horizonSeconds)));
  if (discount >= DISCOUNT_DENOMINATOR) return { makerAmount: 0n, fee: 0n, received: 0n };
  const makerAmount = (BigInt(gross) * (DISCOUNT_DENOMINATOR - discount)) / DISCOUNT_DENOMINATOR;
  const fee = (makerAmount * BigInt(feeBps || 0)) / 10_000n;
  return { makerAmount, fee, received: makerAmount - fee };
}

/**
 * The signed floor for a fill of `takerAmountIn` out of `takerAmount`. The
 * contract enforces minReceivedAmount pro-rata and rounds up.
 */
export function minReceived(minReceivedAmount, takerAmountIn, takerAmount) {
  const total = BigInt(takerAmount || 0);
  if (!total) return BigInt(minReceivedAmount || 0);
  const x = BigInt(minReceivedAmount || 0) * BigInt(takerAmountIn ?? takerAmount);
  return (x + total - 1n) / total;
}

/**
 * A starting point for the user's own floor: the oracle value less a maximum
 * rate over the horizon, less the fee. Mirrors how the backend derives
 * minReceivedAmount when you don't send one.
 */
export function suggestedMinimum(gross, maxBpsPerDay, horizonSeconds, feeBps) {
  return expectedReceived(gross, maxBpsPerDay, horizonSeconds, feeBps).received;
}

// Any error -> one line for the user. RFQ reverts come back named.
export function parseRfqError(e) {
  return toRfqError(e).message;
}
