import { executeBid } from './wallet';

/**
 * Accept a bid. Used by both the instant page and the auctions page, because
 * the steps are identical once you have a requestId and a bidId.
 *
 * Returns { settlement: 'instant', txHash } or { settlement: 'delayed', settlesBy }.
 */
export async function acceptBid({ oct, requestId, chainId, account, bidId, onStep = () => {} }) {
  onStep('Loading bid');

  // Re-read right before sending, always. The execute txn carries a nonce that
  // moves when any other order settles, so calldata fetched even a minute ago
  // is likely stale, and it fails after the user has paid for the approval.
  const { bids } = await oct.swapStatus(requestId);
  const bid = (bids || []).find((b) => b.bidId === bidId);
  if (!bid) throw new Error('That bid is gone. Refresh and pick another.');
  if (!bid.txns?.length) throw new Error('Settlement busy, try again in a few seconds.');

  // chainId is the REQUEST's chain, not whichever one the app is showing.
  const txHash = await executeBid(bid, chainId, account, onStep);

  if (bid.settlementType === 'delayed') {
    // txns was the approval only, so there is nothing to report as a fill.
    // This call locks the bid; Octarine settles once the solver funds.
    onStep('Accepting');
    const { data } = await oct.acceptDelayed(requestId, bid.bidId);
    return { settlement: 'delayed', settlesBy: data.scheduleSettlementTime };
  }

  if (!txHash) throw new Error('No fill transaction was sent.');
  onStep('Recording fill');
  await oct.recordFill({
    requestId,
    bidId: bid.bidId,
    txHash,
    filledAmount: bid.takerAmount,
    marketMaker: bid.marketMaker,
  });
  return { settlement: 'instant', txHash };
}
