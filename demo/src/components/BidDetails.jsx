import { useEffect, useState } from 'react';
import {
  durationCovered,
  feePct,
  fmt,
  n,
  settlementTime,
  short,
  totalSlippagePct,
} from '../lib/format';

/**
 * Everything worth knowing about one bid before accepting it.
 *
 * All of it comes off the bid returned by GET /swap/:requestId, nothing here
 * needs a second call.
 */
export default function BidDetails({ bid, buySymbol, sellSymbol }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const receive = fmt(bid.makerAmount, bid.metadata?.redemptionAssetData?.decimals);
  const fee = feePct(bid);
  const total = totalSlippagePct(bid);
  // bid.fee is in raw SELL-token units, same as request.fee.
  const feeAmount = fmt(bid.fee, bid.metadata?.redeemAssetData?.decimals);

  return (
    <div className="panel">
      <div className="receive">
        <span>You receive</span>
        <strong>{n(receive)} {buySymbol}</strong>
      </div>

      <dl className="rows">
        <Row label="Settlement time" value={settlementTime(bid)} />
        <Row label="Duration covered" value={durationCovered(bid, now)} />
        <Row
          label="Redemption fee"
          value={`${fee.toFixed(2)}%`}
          note={feeAmount ? `${n(feeAmount)} ${sellSymbol || ''}`.trim() : undefined}
        />
        <Row
          label="Total slippage"
          value={`${total.toFixed(2)}%`}
        />
        <Row
          label="Bidder"
          value={bid.marketMakerName || short(bid.marketMaker)}
        />
        {bid.networkCostUSD != null && (
          <Row label="Network cost" value={bid.networkCostUSD < 0.01 ? '<$0.01' : `$${bid.networkCostUSD}`} />
        )}
      </dl>
    </div>
  );
}

function Row({ label, value, note }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <span className="note">{note}</span>}
      </dd>
    </div>
  );
}
