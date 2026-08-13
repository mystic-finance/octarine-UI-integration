import { useCallback, useEffect, useState } from 'react';
import BidsModal from './BidsModal';
import { countdown, fmt, n } from '../lib/format';

export default function MyAuctions({ oct, account, chainId, reload }) {
  const [rows, setRows] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [openRow, setOpenRow] = useState(null);

  const load = useCallback(async () => {
    if (!account) return setRows([]);
    try {
      // No status filter, so this is the full history. Add open=true for only
      // the rows the user can still act on, or status='filled,expired'.
      const r = await oct.myOrders(account, { chainId, limit: 10 });
      setRows(r.data.transactions.data);
    } catch (e) {
      alert(e.message);
    }
  }, [oct, account, chainId]);

  useEffect(() => {
    load();
  }, [load, reload]);

  // one for the countdown, one to pick up new bids
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(load, 20000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [load]);

  return (
    <section className="card">
      <div className="head">
        <h2>My auctions</h2>
        <button className="ghost" onClick={load}>Refresh</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>You sell</th>
            <th>Best bid</th>
            <th>Expires</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                {account ? 'No auctions yet.' : 'Connect a wallet.'}
              </td>
            </tr>
          )}

          {rows.map((row) => {
            // txHash beats status, which lags a poll cycle after a fill.
            // After that go by the clock: the expiry sweep lags too, and an
            // accept on a closed window just reverts.
            const filled = !!row.txHash || row.status === 'filled';
            const left = Math.max(0, Math.floor((row.expiryTime || 0) - now / 1000));
            const state = filled ? 'accepted' : left <= 0 ? 'expired' : 'live';

            const bidAmt =
              row.bid && fmt(row.bid.makerAmount, row.bid.metadata?.redemptionAssetData?.decimals);

            return (
              <tr key={row.requestId}>
                <td>{n(row.sellToken.amount)} {row.sellToken.symbol}</td>
                <td>
                  {bidAmt
                    ? <strong className="bid">{n(bidAmt)} {row.buyToken.symbol}</strong>
                    : state === 'live' ? <span className="muted">No bids yet</span> : '—'}
                </td>
                <td className={state === 'live' && left < 3600 ? 'urgent' : ''}>
                  {state === 'live' ? countdown(left) : '—'}
                </td>
                <td><span className={`pill ${state}`}>{state}</span></td>
                <td className="right">
                  {state === 'live' && (
                    <button className="primary sm" disabled={!row.bid} onClick={() => setOpenRow(row)}>
                      See bids
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {openRow && (
        <BidsModal
          oct={oct}
          account={account}
          row={openRow}
          onClose={() => setOpenRow(null)}
          onDone={() => {
            setOpenRow(null);
            load();
          }}
        />
      )}
    </section>
  );
}
