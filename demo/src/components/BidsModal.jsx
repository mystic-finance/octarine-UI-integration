import { useCallback, useEffect, useState } from 'react';
import { acceptBid } from '../lib/acceptBid';
import { countdown, fmt, horizon, n, parseRfqError, rate, settlementTime, short } from '../lib/format';
import Spinner from './Spinner';

// Every bid on one auction. GET /swap/:requestId is the only place bids come
// with txns, so this is also what the accept runs against.
//
// Bids are rates, ranked lowest bps/day first (= most for the seller). "You
// receive" is the server's quote at read time; acceptBid re-quotes on-chain
// before anything is sent, and the fill pays at least the signed minimum.
export default function BidsModal({ oct, account, row, onClose, onDone }) {
  const [bids, setBids] = useState(null); // null while loading
  const [busyBid, setBusyBid] = useState('');
  const [step, setStep] = useState('');
  const [now, setNow] = useState(Date.now() / 1000);

  const load = useCallback(async () => {
    try {
      const { bids } = await oct.swapStatus(row.requestId);
      setBids(bids || []);
    } catch (e) {
      alert(e.message);
      setBids([]);
    }
  }, [oct, row.requestId]);

  useEffect(() => {
    load();
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(tick);
  }, [load]);

  async function accept(bid) {
    setBusyBid(bid.bidId);
    try {
      const res = await acceptBid({
        oct,
        requestId: row.requestId,
        chainId: row.chainId,
        account,
        bidId: bid.bidId,
        onStep: setStep,
      });
      const decimals = bid.metadata?.redemptionAssetData?.decimals;
      if (res.settlement === 'delayed') {
        alert(
          'Accepted. Octarine fills this bid with your signed request' +
            (res.settlesBy ? ` by about ${new Date(res.settlesBy).toLocaleString()}.` : ' once the bidder funds.'),
        );
      } else {
        alert(
          res.filled
            ? `Filled. You received ${n(fmt(res.filled.received, decimals))} ${row.buyToken.symbol}.\n\n${res.txHash}`
            : `Filled.\n\n${res.txHash}`,
        );
      }
      onDone();
    } catch (e) {
      alert(parseRfqError(e));
      load();
    } finally {
      setBusyBid('');
      setStep('');
    }
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="head">
          <h2>Bids</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>

        <p className="sub">
          Selling {n(row.sellToken.amount)} {row.sellToken.symbol} for {row.buyToken.symbol}.
          Lowest rate first.
        </p>

        {bids === null && <p className="hint">Loading...</p>}
        {bids?.length === 0 && <p className="hint">No bids on this auction yet.</p>}

        {bids?.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Solver</th>
                <th>Rate</th>
                <th>You receive</th>
                <th>Horizon</th>
                <th>Fee</th>
                <th>Bid expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bids.map((bid) => {
                const decimals = bid.metadata?.redemptionAssetData?.decimals;
                const left = Math.floor(Number(bid.makerExpiry) - now);
                return (
                  <tr key={bid.bidId}>
                    <td title={bid.marketMaker}>
                      {bid.marketMakerName || short(bid.marketMaker)}
                      {bid.trustScore != null && (
                        <div className="muted">Trust score {bid.trustScore}/100</div>
                      )}
                      <div className="muted">{bid.settlementType === 'delayed' ? `Delayed, ${settlementTime(bid)}` : 'Instant'}</div>
                    </td>
                    <td>{rate(bid.makerBpsPerDay)}</td>
                    <td>
                      <strong className="bid">
                        {n(fmt(bid.quotedNet, decimals))} {row.buyToken.symbol}
                      </strong>
                      <div className="muted">quote</div>
                    </td>
                    <td>{horizon(bid.horizonSeconds)}</td>
                    <td>
                      {bid.feeBps != null ? `${bid.feeBps} bps` : '—'}
                      {bid.quotedFee != null && (
                        <div className="muted">{n(fmt(bid.quotedFee, decimals))} {row.buyToken.symbol}</div>
                      )}
                    </td>
                    <td className={left < 300 ? 'urgent' : ''}>{countdown(left)}</td>
                    <td className="right">
                      <button
                        className="primary sm"
                        disabled={!!busyBid || left <= 0}
                        onClick={() => accept(bid)}
                      >
                        {busyBid === bid.bidId && <Spinner />}
                        {busyBid === bid.bidId ? step || 'Working...' : 'Accept bid'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
