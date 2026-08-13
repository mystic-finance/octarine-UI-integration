import { useCallback, useEffect, useState } from 'react';
import { acceptBid } from '../lib/acceptBid';
import { fmt, n, settlementTime, short } from '../lib/format';

// Every bid on one auction. GET /swap/:requestId is the only place bids come
// with txns, so this is also what the accept runs against.
export default function BidsModal({ oct, account, row, onClose, onDone }) {
  const [bids, setBids] = useState(null); // null while loading
  const [busyBid, setBusyBid] = useState('');
  const [step, setStep] = useState('');

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
      alert(
        res.settlement === 'delayed'
          ? `Accepted.\n\nSettles by ${new Date(res.settlesBy).toLocaleString()}.`
          : `Filled.\n\n${res.txHash}`,
      );
      onDone();
    } catch (e) {
      alert(e.message);
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
          Top 3 shown, best first.
        </p>

        {bids === null && <p className="hint">Loading...</p>}
        {bids?.length === 0 && <p className="hint">No bids on this auction yet.</p>}

        {bids?.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Bidder</th>
                <th>You receive</th>
                <th>Settlement</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bids.map((bid) => (
                <tr key={bid.bidId}>
                  <td title={bid.marketMaker}>
                    {bid.marketMakerName || short(bid.marketMaker)}
                    {bid.trustScore != null && (
                      <div className="muted">Trust score {bid.trustScore}/100</div>
                    )}
                  </td>
                  <td>
                    <strong className="bid">
                      {n(fmt(bid.makerAmount, bid.metadata?.redemptionAssetData?.decimals))}{' '}
                      {row.buyToken.symbol}
                    </strong>
                    {bid.networkCostUSD != null && (
                      <div className="muted">gas ~${bid.networkCostUSD}</div>
                    )}
                  </td>
                  <td>{settlementTime(bid)}</td>
                  <td className="right">
                    <button className="primary sm" disabled={!!busyBid} onClick={() => accept(bid)}>
                      {busyBid === bid.bidId ? step || 'Working...' : 'Accept bid'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
