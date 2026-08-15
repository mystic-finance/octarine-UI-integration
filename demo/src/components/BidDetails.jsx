import { feeLabel, fmt, n, settlementTime, short, totalSlippagePct } from '../lib/format';

/**
 * Everything worth knowing about one bid before accepting it.
 *
 * All of it comes off the bid returned by GET /swap/:requestId, except
 * `redemptionTime`, which is a property of the asset rather than the bid and
 * comes from GET /tokens/redemption-times.
 */
export default function BidDetails({ bid, buySymbol, sellSymbol, redemptionTime }) {
  const receive = fmt(bid.makerAmount, bid.metadata?.redemptionAssetData?.decimals);
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
        <Row label="Duration covered" value={redemptionTime || '—'} />
        <Row label="Redemption fee" value={feeLabel(bid, redemptionTime)} />
        <Row label="Total slippage" value={`${total.toFixed(2)}%`} />
        <Row label="Solver" value={bid.marketMakerName || short(bid.marketMaker)} />
        {bid.networkCostUSD != null && (
          <Row
            label="Network cost"
            value={bid.networkCostUSD < 0.01 ? '<$0.01' : `$${bid.networkCostUSD}`}
          />
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
