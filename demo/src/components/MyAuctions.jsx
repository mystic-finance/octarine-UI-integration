import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import BidsModal from './BidsModal';
import { isLegacyRequest, isOpenRow } from '../lib/legacy';
import { cancelRequest, requestTypedData, signRequest } from '../lib/wallet';
import { countdown, fmt, n, parseRfqError, rate } from '../lib/format';

const SETTLING = new Set(['solving', 'processing', 'finalizing', 'settling']);

// The request terms: the order template (every signed request field, maker
// fields blank), the RFQ it was built for, and whether the user has signed
// yet. Never the signature itself. GET /orders rows are a summary without
// them, so open rows carry `detail`, the full record from GET /request/:id.
function rowTerms(row) {
  const d = row.detail || row;
  const m = d.metadata || {};
  return {
    template: d.rfqOrder || m.rfqOrder,
    rfq: d.rfqContract || m.rfqContract,
    salt: d.salt ?? d.rfqOrder?.salt ?? m.rfqOrder?.salt,
    signatureRequired: d.signatureRequired ?? m.signatureRequired ?? false,
  };
}

function rowState(row, nowSec) {
  // txHash beats status, which lags a poll cycle after a fill. After that go
  // by the clock: the expiry sweep lags too, and a fill past expiry reverts.
  if (row.txHash || row.status === 'filled' || row.status === 'partially_filled') return 'filled';
  if (row.status === 'cancelled') return 'cancelled';
  if (SETTLING.has(row.status)) return 'settling';
  if (row.status === 'expired' || (row.expiryTime || 0) <= nowSec) return 'expired';
  // Made for the v1 contract: nothing can settle it now.
  if (isLegacyRequest(row.detail)) return 'legacy';
  if (rowTerms(row).signatureRequired) return 'awaiting';
  return 'live';
}

const PILL = {
  filled: ['accepted', 'filled'],
  cancelled: ['cancelled', 'cancelled'],
  settling: ['settling', 'settling'],
  expired: ['expired', 'expired'],
  awaiting: ['awaiting', 'awaiting signature'],
  legacy: ['cancelled', 'v1 request'],
  live: ['live', 'live'],
};

export default function MyAuctions({ oct, account, chainId, rfq, reload }) {
  const [rows, setRows] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [openRow, setOpenRow] = useState(null);
  const [busy, setBusy] = useState(''); // `${requestId}:${what}`

  const load = useCallback(async () => {
    if (!account) return setRows([]);
    try {
      // No status filter, so this is the full history. Add open=true for only
      // the rows the user can still act on, or status='filled,expired'.
      const r = await oct.myOrders(account, { chainId, limit: 10 });
      const list = r.data.transactions.data;
      // Open rows need their signed terms (salt, signatureRequired, rfqOrder)
      // to sign or cancel, and those are only on GET /request/:id.
      const details = await Promise.all(
        list.map((row) => (isOpenRow(row) ? oct.request(row.requestId).catch(() => null) : null)),
      );
      setRows(list.map((row, i) => (details[i] ? { ...row, detail: details[i] } : row)));
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

  // A request created but never signed (the user closed the wallet prompt).
  // Rebuild the typed data from the stored terms and sign it now.
  async function sign(row) {
    const { template, rfq: rowRfq } = rowTerms(row);
    if (!template) return alert('This request has no terms to sign. Create a new one.');
    setBusy(`${row.requestId}:sign`);
    try {
      const typedData = requestTypedData(template, row.chainId, rowRfq || rfq);
      const signature = await signRequest(typedData, row.chainId, { rfq, account });
      await oct.submitRequestSignature(row.requestId, signature);
      load();
    } catch (e) {
      alert(parseRfqError(e));
    } finally {
      setBusy('');
    }
  }

  // Closing the row stops new bids; only cancelSalt on-chain stops a signed
  // request from settling, since the signature is already out of your hands.
  async function cancel(row) {
    if (!window.confirm('Cancel this auction?')) return;
    const { rfq: rowRfq, salt, signatureRequired } = rowTerms(row);
    setBusy(`${row.requestId}:cancel`);
    try {
      let cancelTx = null;
      try {
        ({ cancelTx } = await oct.cancelRequest(row.requestId));
      } catch {
        // Origin-allowlisted; build cancelSalt ourselves below.
      }
      if (!signatureRequired) {
        await cancelRequest({
          chainId: row.chainId,
          account,
          cancelTx,
          rfq: rowRfq || rfq,
          salt,
        });
      }
      load();
    } catch (e) {
      alert(parseRfqError(e));
    } finally {
      setBusy('');
    }
  }

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
            const nowSec = now / 1000;
            const state = rowState(row, nowSec);
            const open = state === 'live' || state === 'awaiting';
            const left = Math.max(0, Math.floor((row.expiryTime || 0) - nowSec));
            const [pillClass, pillText] = PILL[state];

            // Best bid by what the seller gets: the quoted net payout.
            const b = row.bid;
            const decimals = b?.metadata?.redemptionAssetData?.decimals;
            const bidAmt = b && fmt(b.quotedNet ?? b.makerAmount, decimals);

            return (
              <tr key={row.requestId}>
                <td>{n(row.sellToken.amount)} {row.sellToken.symbol}</td>
                <td>
                  {bidAmt ? (
                    <>
                      <strong className="bid">{n(bidAmt)} {row.buyToken.symbol}</strong>
                      {b.makerBpsPerDay != null && <div className="muted">{rate(b.makerBpsPerDay)}</div>}
                    </>
                  ) : open ? (
                    <span className="muted">No bids yet</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={open && left < 3600 ? 'urgent' : ''}>{open ? countdown(left) : '—'}</td>
                <td><span className={`pill ${pillClass}`}>{pillText}</span></td>
                <td className="right">
                  <div className="actions">
                    {state === 'awaiting' && (
                      <button className="primary sm" disabled={!!busy} onClick={() => sign(row)}>
                        {busy === `${row.requestId}:sign` ? 'Sign in wallet' : 'Sign'}
                      </button>
                    )}
                    {state === 'live' && (
                      <button className="primary sm" disabled={!b} onClick={() => setOpenRow(row)}>
                        See bids
                      </button>
                    )}
                    {state === 'legacy' && (
                      <Link className="ghost" to="/migrate">Migrate</Link>
                    )}
                    {open && (
                      <button className="ghost" disabled={!!busy} onClick={() => cancel(row)}>
                        {busy === `${row.requestId}:cancel` ? 'Cancelling...' : 'Cancel'}
                      </button>
                    )}
                  </div>
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
