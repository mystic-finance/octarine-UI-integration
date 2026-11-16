import { executeBid, quoteBid } from './wallet';

// A bid this close to its makerExpiry may lapse while the user is still in
// the wallet, and the fill would revert OrderExpired after the approval.
const EXPIRY_MARGIN_SECONDS = 60;

/**
 * Accept a bid. Used by both the instant page and the auctions page, because
 * the steps are identical once you have a requestId and a bidId.
 *
 *   1. re-read the bid (txns are built for the bid as it stands now)
 *   2. check it hasn't lapsed, and re-price it with quoteRFQOrder
 *   3. send bid.txns: approve the RFQ, then fillRFQOrder (simulated first)
 *   4. instant: report the fill with the amounts from RFQOrderFilled
 *
 * Returns
 *   { settlement: 'instant', txHash, filled, quote, bid }   filled = actual amounts
 *   { settlement: 'delayed', quote, bid, settlesBy }        Octarine fills it later
 */
export async function acceptBid({ oct, requestId, chainId, account, bidId, onStep = () => {} }) {
  onStep('Loading bid');

  // Re-read right before sending, always. Bids lapse (makerExpiry), get
  // withdrawn, or get re-ranked, and an old copy fails after the approval.
  const status = await oct.swapStatus(requestId);
  if (status.signatureRequired) {
    throw new Error('Sign the request first. A bid cannot settle without your signature.');
  }
  const bid = (status.bids || []).find((b) => b.bidId === bidId);
  if (!bid) throw new Error('That bid is gone. Refresh and pick another.');
  if (Number(bid.makerExpiry) <= Date.now() / 1000 + EXPIRY_MARGIN_SECONDS) {
    throw new Error('That bid is about to expire. Pick another.');
  }
  if (!bid.txns?.length) throw new Error('This bid has no settlement transactions yet. Try again in a few seconds.');

  // The bid's quotedNet is a snapshot. The oracle and, for a cyclical asset,
  // the horizon have both moved since, so price it again with the same view
  // the fill uses. Null for a bundled bid, which we can only simulate.
  onStep('Re-quoting');
  const quote = await quoteBid(bid, chainId);
  if (bid.settlementType !== 'delayed' && quote) {
    if (quote.overCap) throw new Error("The price moved past the bidder's limit. Pick another bid.");
    if (quote.belowFloor) throw new Error('This bid now pays less than the minimum you signed. Pick another bid.');
  }

  // chainId is the REQUEST's chain, not whichever one the app is showing.
  const { txHash, filled } = await executeBid(bid, chainId, account, onStep);

  if (bid.settlementType === 'delayed') {
    // txns was the approval only. Tell Octarine which delayed bid you picked;
    // it then fills that bid with your stored request signature once the
    // bidder funds.
    onStep('Locking in bid');
    await oct.acceptDelayed(requestId, bid.bidId);
    const eta = Number(bid.estimatedSettlementTime) || 0;
    return {
      settlement: 'delayed',
      bid,
      quote,
      settlesBy: eta ? Date.now() + eta * 1000 : null,
    };
  }

  if (!txHash) throw new Error('No fill transaction was sent.');

  onStep('Recording fill');
  const takerAmountFilled = filled?.takerAmountFilled ?? quote?.takerAmountIn ?? BigInt(bid.takerAmount);
  let recorded = null;
  try {
    // Idempotent, so a retry is safe. The swap already happened on-chain; a
    // failure here only delays the request showing as filled.
    recorded = await oct.recordFill({
      requestId,
      bidId: bid.bidId,
      txHash,
      marketMaker: bid.marketMaker,
      filledAmount: takerAmountFilled.toString(),
      ...(filled && {
        makerAmount: filled.makerAmount.toString(),
        fee: filled.fee.toString(),
        receivedAmount: filled.received.toString(),
      }),
    });
  } catch (e) {
    console.warn('POST /fill failed; the fill is on-chain and will be picked up from the event', e);
  }

  // The receipt is the source of truth. Fall back to what /fill decoded from
  // it, then to the pre-trade quote, for bids settled through a bundle.
  const fromApi = recorded?.data;
  const actual =
    filled ||
    (fromApi?.receivedAmount && {
      received: BigInt(fromApi.receivedAmount),
      fee: BigInt(fromApi.fee ?? 0),
      makerAmount: BigInt(fromApi.makerAmount ?? fromApi.receivedAmount),
      horizonSeconds: Number(fromApi.horizonSeconds) || quote?.horizonSeconds,
      takerAmountFilled,
    }) ||
    null;

  return { settlement: 'instant', txHash, filled: actual, quote, bid };
}
