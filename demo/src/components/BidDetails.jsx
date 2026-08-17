import {
  DEFAULT_REDEMPTION_TIME,
  bpsPerDay,
  feeBps,
  fmt,
  n,
  settlementTime,
  short,
  totalBps,
} from '../lib/format';

/**
 * Everything worth knowing about one bid before accepting it.
 *
 * All of it comes off the bid returned by GET /swap/:requestId, except
 * `redemptionTime`, which is a property of the asset rather than the bid and
 * comes from GET /tokens/redemption-times.
 */
export default function BidDetails({ bid, buySymbol, sellSymbol, redemptionTime }) {
  const receive = fmt(bid.makerAmount, bid.metadata?.redemptionAssetData?.decimals);
  const window = redemptionTime || DEFAULT_REDEMPTION_TIME;

  return (
    <div className="panel">
      <div className="receive">
        <span>You receive</span>
        <strong>{n(receive)} {buySymbol}</strong>
      </div>

      <dl className="rows">
        <Row label="Settlement time" value={settlementTime(bid)} />
        <Row label="Duration covered" value={window} />
        <Row label="Protocol fee" value={bpsPerDay(feeBps(bid), window)} />
        <Row label="Total slippage" value={bpsPerDay(totalBps(bid), window)} />
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
