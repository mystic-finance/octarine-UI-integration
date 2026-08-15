import { ethers } from 'ethers';

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

// bid.estimatedSettlementTime is seconds: 60 for instant, the real window for delayed.
export function settlementTime(bid) {
  const s = bid.estimatedSettlementTime || 0;
  if (bid.settlementType !== 'delayed') return s > 90 ? `~${Math.round(s / 60)} minutes` : '~1 minute';
  const hours = Math.round(s / 3600);
  if (!hours) return 'Later today';
  return hours >= 24 ? `~${Math.round(hours / 24)} days` : `~${hours} hours`;
}

// The protocol fee as a percentage of the GROSS sell amount. `takerAmount` is
// already net of the fee, so the denominator has to add it back.
export function feePct(bid) {
  const fee = Number(bid.fee);
  const taker = Number(bid.takerAmount);
  if (!Number.isFinite(fee) || !Number.isFinite(taker) || fee <= 0) return 0;
  const gross = taker + fee;
  return gross > 0 ? (fee / gross) * 100 : 0;
}

// What the user actually gives up against the oracle price: the solver's own
// spread (bid.slippage, already a percent) plus the protocol fee.
export function totalSlippagePct(bid) {
  return (Number(bid.slippage) || 0) + feePct(bid);
}

// Same fee expressed in basis points, which is how fees are quoted.
export function feeBps(bid) {
  return Math.round(feePct(bid) * 100);
}

// "T+3" -> 3. Null when the asset has no registered window, or it settles
// same-day (T+0), where a per-day rate has nothing to divide by.
export function redemptionDays(redemptionTime) {
  const m = /^T\+(\d+)/i.exec(String(redemptionTime || ''));
  const days = m ? Number(m[1]) : 0;
  return days > 0 ? days : null;
}

// The protocol fee is priced against the redemption window, so quote it per
// day. Falls back to the flat figure when the window is unknown.
export function feeLabel(bid, redemptionTime) {
  const bps = feeBps(bid);
  const days = redemptionDays(redemptionTime);
  if (!days) return `${bps} bps / day`;
  const perDay = bps / days;
  return `${perDay < 1 ? perDay.toFixed(2) : Math.round(perDay * 100) / 100} bps / day`;
}
