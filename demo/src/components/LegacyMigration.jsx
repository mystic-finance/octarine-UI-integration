import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { V1_CONTRACT, readLegacyAllowances, readLegacyRequests, revokeLegacyApproval } from '../lib/legacy';
import { txUrl } from '../lib/wallet';
import { countdown, fmt, n, parseRfqError, short } from '../lib/format';

/**
 * What this wallet still has from the v1 Octarine contract on `chainId`: approvals to revoke and open requests that
 * can no longer settle. Shared by the banner in App.jsx and the /migrate page,
 * so both show the same counts.
 */
export function useLegacyScan({ oct, account, chainId, tokens }) {
  const [state, setState] = useState({ loading: false, approvals: [], requests: [], error: '' });

  const scan = useCallback(async () => {
    if (!account || !V1_CONTRACT[chainId]) {
      return setState({ loading: false, approvals: [], requests: [], error: '' });
    }
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const [approvals, requests] = await Promise.all([
        readLegacyAllowances(tokens, account, chainId),
        readLegacyRequests(oct, account, chainId).catch(() => []),
      ]);
      setState({ loading: false, approvals, requests, error: '' });
    } catch (e) {
      setState({ loading: false, approvals: [], requests: [], error: e.message });
    }
  }, [oct, account, chainId, tokens]);

  useEffect(() => {
    scan();
  }, [scan]);

  return { ...state, count: state.approvals.length + state.requests.length, scan };
}

/** Banner for the other pages: shown only when there is something to clean up. */
export function LegacyBanner({ scan }) {
  if (!scan.count) return null;
  const parts = [];
  if (scan.approvals.length) parts.push(`${scan.approvals.length} approval${scan.approvals.length > 1 ? 's' : ''}`);
  if (scan.requests.length) parts.push(`${scan.requests.length} open request${scan.requests.length > 1 ? 's' : ''}`);
  return (
    <div className="banner info">
      <span>Octarine has moved to v2. You still have {parts.join(' and ')} on v1.</span>
      <Link className="ghost" to="/migrate">Review</Link>
    </div>
  );
}

const MAX = ethers.MaxUint256;

/** The /migrate page. */
export default function LegacyMigration({ oct, account, chainId, rfq, scan }) {
  const [busy, setBusy] = useState(''); // `${kind}:${id}`
  const [step, setStep] = useState('');
  const [done, setDone] = useState({}); // id -> tx hash or 'closed'
  const nowSec = Date.now() / 1000;
  const oldContract = V1_CONTRACT[chainId];

  async function revoke({ token }) {
    setBusy(`approval:${token.address}`);
    try {
      const hash = await revokeLegacyApproval(token.address, chainId, setStep);
      setDone((d) => ({ ...d, [token.address]: hash }));
      scan.scan();
    } catch (e) {
      alert(parseRfqError(e));
    } finally {
      setBusy('');
      setStep('');
    }
  }

  // Nothing on v2 can fill a v1 request, and revoking the v1 approval above
  // stops it filling on v1, so closing it off-chain is enough. The DELETE is origin-
  // allowlisted; if it refuses, the request simply expires on its own.
  async function close(row) {
    setBusy(`request:${row.requestId}`);
    try {
      await oct.cancelRequest(row.requestId);
      setDone((d) => ({ ...d, [row.requestId]: 'closed' }));
      scan.scan();
    } catch (e) {
      alert(
        e.status === 403
          ? 'This site is not allowed to close requests. It cannot settle any more and will expire on its own.'
          : e.message,
      );
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="card narrow wide">
      <div className="head">
        <h2>Move from Octarine v1 to v2</h2>
        <button className="ghost" onClick={scan.scan} disabled={scan.loading}>
          {scan.loading ? 'Checking...' : 'Check again'}
        </button>
      </div>

      <p className="sub">
        Octarine now settles on <strong>OctarineRFQ</strong>
        {rfq && <> ({short(rfq)})</>} instead of the v1 contract
        {oldContract && <> ({short(oldContract)})</>}. Neither contract holds your funds, but there are two things to
        tidy up on v1.
      </p>

      {!account && <p className="muted">Connect a wallet to check it.</p>}
      {account && !oldContract && <p className="muted">Octarine v1 was never deployed on this chain.</p>}
      {scan.error && <p className="muted">Could not check: {scan.error}</p>}

      {account && oldContract && (
        <>
          <h3>Approvals to the v1 contract</h3>
          <p className="muted">
            Nothing uses these any more. Revoking sets the allowance to zero; it costs a little gas and moves no funds.
          </p>
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Approved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {scan.approvals.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">{scan.loading ? 'Checking...' : 'None. Nothing to revoke.'}</td>
                </tr>
              )}
              {scan.approvals.map((a) => (
                <tr key={a.token.address}>
                  <td>{a.token.symbol}</td>
                  <td>{a.allowance >= MAX / 2n ? 'Unlimited' : n(fmt(a.allowance, a.token.decimals))}</td>
                  <td className="right">
                    <button className="primary sm" disabled={!!busy} onClick={() => revoke(a)}>
                      {busy === `approval:${a.token.address}` ? step || 'Revoking...' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Open v1 requests</h3>
          <p className="muted">
            These were made for the v1 contract, so no bid can settle them now. Close them and{' '}
            <Link to="/">sell again</Link> with a new request: you will sign its terms once, and bidders quote a rate
            instead of an amount.
          </p>
          <table>
            <thead>
              <tr>
                <th>You sell</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {scan.requests.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">{scan.loading ? 'Checking...' : 'None.'}</td>
                </tr>
              )}
              {scan.requests.map((row) => (
                <tr key={row.requestId}>
                  <td>{n(row.sellToken.amount)} {row.sellToken.symbol}</td>
                  <td>{countdown(Math.floor((row.expiryTime || 0) - nowSec))}</td>
                  <td className="right">
                    <button className="ghost" disabled={!!busy} onClick={() => close(row)}>
                      {busy === `request:${row.requestId}` ? 'Closing...' : 'Close'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {Object.entries(done).some(([, v]) => v !== 'closed') && (
            <p className="muted">
              Revoked:{' '}
              {Object.entries(done)
                .filter(([, v]) => v !== 'closed')
                .map(([addr, hash]) => {
                  const url = txUrl(chainId, hash);
                  return url ? <a key={addr} href={url} target="_blank" rel="noreferrer">{short(hash)} </a> : <span key={addr}>{short(hash)} </span>;
                })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
