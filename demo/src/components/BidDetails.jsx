import {
  discountBps,
  fmt,
  horizon,
  minReceived,
  n,
  pct,
  rate,
  settlementTime,
  short,
  when,
} from '../lib/format';

/**
 * Everything worth knowing about one bid before accepting it.
 *
 * A bid is a rate (bps/day) charged over the time left until the asset
 * redeems; the amount is worked out on-chain when the fill lands. So the
 * headline is a QUOTE, and the number the user can rely on is the minimum
 * they signed.
 *
 * `bid` comes from GET /swap/:requestId. `quote` is optional: the live
 * quoteRFQOrder result (lib/wallet quoteBid), which beats the bid's own
 * quotedNet snapshot when present. `terms` is the signed request
 * ({ minReceivedAmount, takerAmount, feeBps }), for the floor.
 */
export default function BidDetails({ bid, quote, terms, buySymbol, buyDecimals }) {
  const decimals = bid.metadata?.redemptionAssetData?.decimals ?? buyDecimals;

  const received = quote?.received ?? bid.quotedNet;
  const fee = quote?.fee ?? bid.quotedFee;
  const seconds = quote?.horizonSeconds ?? bid.horizonSeconds;
  const feeBps = bid.feeBps ?? terms?.feeBps;

  const floor =
    quote?.floor ??
    (terms?.minReceivedAmount
      ? minReceived(terms.minReceivedAmount, bid.takerAmount, terms.takerAmount)
      : null);

  const discount = discountBps(bid.makerBpsPerDay, seconds);
  const delayed = bid.settlementType === 'delayed';

  return (
    <div className="panel">
      <div className="receive">
        <span>You receive (quote)</span>
        <strong>{received != null ? `${n(fmt(received, decimals))} ${buySymbol}` : '—'}</strong>
      </div>

      <dl className="rows">
        {floor != null && (
          <Row
            label="At least"
            value={`${n(fmt(floor, decimals))} ${buySymbol}`}
            note="The minimum you signed. The fill reverts below it."
          />
        )}
        <Row label="Rate" value={rate(bid.makerBpsPerDay)} />
        <Row label="Horizon" value={horizon(seconds)} note="Time until the asset redeems" />
        {Number.isFinite(discount) && (
          <Row label="Discount" value={`${discount.toFixed(2)} bps`} note={pct(discount)} />
        )}
        {feeBps != null && (
          <Row
            label="Fee"
            value={`${feeBps} bps`}
            note={fee != null ? `${n(fmt(fee, decimals))} ${buySymbol}` : undefined}
          />
        )}
        <Row
          label="Settlement"
          value={delayed ? `Delayed, ${settlementTime(bid)}` : 'Instant'}
          note={delayed ? 'Approve now; Octarine fills it with your signed request' : undefined}
        />
        <Row label="Bid valid until" value={when(bid.makerExpiry)} />
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
