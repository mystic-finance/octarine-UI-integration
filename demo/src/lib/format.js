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

// Assets with no registered window are quoted as next-day.
export const DEFAULT_REDEMPTION_TIME = 'T+1';

// "T+3" -> 3. Everything is priced against this window, so an unparseable or
// same-day value falls back to 1 rather than 0: it is the divisor below.
export function redemptionDays(redemptionTime) {
  const m = /^T\+(\d+)/i.exec(String(redemptionTime || DEFAULT_REDEMPTION_TIME));
  const days = m ? Number(m[1]) : 1;
  return days > 0 ? days : 1;
}

// The protocol fee in bps of the GROSS sell amount. `takerAmount` is already
// net of the fee, so the denominator has to add it back.
export function feeBps(bid) {
  const fee = Number(bid.fee);
  const taker = Number(bid.takerAmount);
  if (!Number.isFinite(fee) || !Number.isFinite(taker) || fee <= 0) return 0;
  const gross = taker + fee;
  return gross > 0 ? Math.round((fee / gross) * 10_000) : 0;
}

// The solver's own spread against the oracle price. bid.slippage is a percent.
export function slippageBps(bid) {
  return Math.round((Number(bid.slippage) || 0) * 100);
}

// Everything the user gives up: the solver's spread plus the protocol fee.
export function totalBps(bid) {
  return slippageBps(bid) + feeBps(bid);
}

// Costs are quoted per day, because they price a T+N redemption window.
export function bpsPerDay(bps, redemptionTime) {
  const perDay = bps / redemptionDays(redemptionTime);
  const rounded = Math.abs(perDay) < 1 ? perDay.toFixed(2) : Math.round(perDay * 100) / 100;
  return `${rounded} bps / day`;
}
