import { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { api } from './api';

const APPROVE_ABI = ['function approve(address,uint256)'];
const ALLOWANCE_ABI = ['function allowance(address,address) view returns (uint256)'];
const DURATIONS = [
  { minutes: 60, label: '1h' },
  { minutes: 1440, label: '1d' },
  { minutes: 10080, label: '7d' },
];

const fmt = (raw, decimals = 18) => {
  try {
    return Number(ethers.formatUnits(BigInt(raw ?? 0), Number(decimals) || 18));
  } catch {
    return 0;
  }
};
const n = (v, d = 4) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString(undefined, { maximumFractionDigits: d }) : '—');
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const countdown = (s) =>
  s <= 0 ? 'Expired' : s > 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  : s > 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  : `${Math.floor(s / 60)}m ${s % 60}s`;

// The wallet's live network drifts from your app's selected chain. A bid's
// calldata is built for one chain only, so switch and re-verify before signing.
async function signerOn(chainId) {
  if (!window.ethereum) throw new Error('No wallet found. Install MetaMask.');
  let provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  if (Number((await provider.getNetwork()).chainId) !== chainId) {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + chainId.toString(16) }],
    });
    provider = new ethers.BrowserProvider(window.ethereum);
    if (Number((await provider.getNetwork()).chainId) !== chainId) {
      throw new Error(`Switch your wallet to chain ${chainId}.`);
    }
  }
  return provider.getSigner();
}

// Run a bid's txns in order ([approval, execute]) and return the last hash.
async function executeBid(bid, chainId, owner, onStep) {
  const signer = await signerOn(chainId);
  let hash = '';
  for (const tx of bid.txns) {
    const isApproval = tx.type?.toLowerCase().includes('approv');
    // Skip an approval that's already covered: re-prompting is bad UX, and some
    // tokens revert when moving a non-zero allowance to another non-zero value.
    if (isApproval) {
      const [spender, needed] = new ethers.Interface(APPROVE_ABI).decodeFunctionData('approve', tx.data);
      const token = new ethers.Contract(tx.to, ALLOWANCE_ABI, signer);
      if ((await token.allowance(owner, spender)) >= BigInt(needed)) continue;
    }
    onStep(isApproval ? 'Approve in wallet…' : 'Confirm in wallet…');
    const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value || undefined });
    await sent.wait();
    hash = sent.hash;
  }
  // '' when every txn was skipped — fine for a delayed bid whose approval
  // already stands, but an instant fill has no hash to record.
  return hash;
}

export default function App() {
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(98866);
  const [chains, setChains] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [log, setLog] = useState([]);

  const oct = useMemo(() => api(), []);
  const push = useCallback((m) => setLog((l) => [m, ...l].slice(0, 20)), []);

  useEffect(() => {
    Promise.all([oct.chains(), oct.tokens()])
      .then(([c, t]) => { setChains(c); setTokens(t); })
      .catch((e) => push(e.message));
  }, [oct, push]);

  const connect = async () => {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      setAccount(await signer.getAddress());
      setChainId(Number((await provider.getNetwork()).chainId));
    } catch (e) {
      push(e.message);
    }
  };

  const [reload, setReload] = useState(0);

  return (
    <div className="app">
      <header>
        <h1>Octarine demo</h1>
        {account ? <span className="badge">{short(account)}</span>
                 : <button className="primary" onClick={connect}>Connect wallet</button>}
      </header>

      <div className="bar">
        <select value={chainId} onChange={(e) => setChainId(Number(e.target.value))}>
          {chains.map((c) => <option key={c.chainId} value={c.chainId}>{c.name}</option>)}
        </select>
      </div>

      <div className="columns">
        <Swap oct={oct} account={account} chainId={chainId} tokens={tokens}
              push={push} onDone={() => setReload((r) => r + 1)} />
        <MyAuctions oct={oct} account={account} chainId={chainId} push={push} reload={reload} />
      </div>

      <pre className="log">{log.join('\n') || 'Ready.'}</pre>
    </div>
  );
}

function Swap({ oct, account, chainId, tokens, push, onDone }) {
  const [sell, setSell] = useState(null);
  const [buy, setBuy] = useState(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState(1440);
  const [out, setOut] = useState(0);
  const [busy, setBusy] = useState('');

  const list = useMemo(() => tokens.filter((t) => t.chainId === chainId), [tokens, chainId]);
  useEffect(() => { setSell(null); setBuy(null); }, [chainId]);

  const wei = sell && Number(amount) > 0 ? ethers.parseUnits(amount, sell.decimals).toString() : null;

  useEffect(() => {
    if (!sell || !buy || !wei) return setOut(0);
    oct.estimate({ chainId, redeemAsset: sell.address, redemptionAsset: buy.address, amount: wei })
      .then((d) => setOut(fmt(d.outputAmount, buy.decimals)))
      .catch(() => setOut(0));
  }, [oct, chainId, sell, buy, wei]);

  const createAuction = async () => {
    setBusy('Placing…');
    try {
      const r = await oct.createSwap({
        chainId,
        walletAddress: account,
        redeemAsset: sell.address,
        redemptionAsset: buy.address,
        amount: wei,
        expiry: duration,          // bidding window, in minutes
        slippageTolerance: 10,
        swapType: 'direct',
        fullAuctionEnabled: true,  // puts it on the board + in My auctions
      });
      push(`Auction created: ${r.requestId}`);
      setAmount('');
      onDone();
    } catch (e) {
      push(e.message);
    } finally {
      setBusy('');
    }
  };

  const disabled = !account || !sell || !buy || !wei || !!busy;

  return (
    <section className="card">
      <h2>Swap</h2>

      <label>You sell</label>
      <div className="row">
        <input className="amt" placeholder="0.0" value={amount}
               onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
        <Picker list={list} value={sell} onChange={setSell} exclude={buy} />
      </div>

      <label>You receive (oracle estimate)</label>
      <div className="row">
        <input className="amt" readOnly value={out ? n(out) : ''} placeholder="0.0" />
        <Picker list={list} value={buy} onChange={setBuy} exclude={sell} />
      </div>

      <label>Auction duration</label>
      <div className="segs">
        {DURATIONS.map((d) => (
          <button key={d.minutes} className={duration === d.minutes ? 'seg on' : 'seg'}
                  onClick={() => setDuration(d.minutes)}>{d.label}</button>
        ))}
      </div>

      <button className="primary" disabled={disabled} onClick={createAuction}>
        {busy || (!account ? 'Connect wallet' : !wei ? 'Enter an amount' : 'Create auction')}
      </button>

      <p className="hint">
        Market makers bid over the window you pick. Accept the best one from My auctions.
      </p>
    </section>
  );
}

function Picker({ list, value, onChange, exclude }) {
  return (
    <select value={value?.address || ''}
            onChange={(e) => onChange(list.find((t) => t.address === e.target.value) || null)}>
      <option value="">Token</option>
      {list.filter((t) => t.address !== exclude?.address).map((t) => (
        <option key={t.address} value={t.address}>{t.symbol}</option>
      ))}
    </select>
  );
}

function MyAuctions({ oct, account, chainId, push, reload }) {
  const [rows, setRows] = useState([]);
  const [busyRow, setBusyRow] = useState('');
  const [step, setStep] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!account) return setRows([]);
    try {
      const r = await oct.myAuctions(account, { chainId, limit: 10, fullAuctionEnabled: true });
      setRows(r.data.transactions.data);
    } catch (e) {
      push(e.message);
    }
  }, [oct, account, chainId, push]);

  useEffect(() => { load(); }, [load, reload]);
  useEffect(() => {
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const accept = async (row) => {
    setBusyRow(row.requestId);
    setStep('Loading bid…');
    try {
      // Re-fetch at click time, always. The execute txn bundles a Safe nonce
      // that moves whenever another order settles — cached calldata reverts.
      const { bids } = await oct.swapStatus(row.requestId);
      const bid = bids?.[0];
      if (!bid) throw new Error('No bids on this auction yet.');

      if (!bid.txns?.length) throw new Error('Settlement busy — try again in a few seconds.');

      // Both paths send txns; settlementType decides what happens after.
      // Settle on the REQUEST's chain, not whichever one the app is showing.
      const txHash = await executeBid(bid, row.chainId, account, setStep);

      if (bid.settlementType === 'delayed') {
        // txns was approval-only — it pre-authorises the pull. This call
        // locks the bid; Octarine settles once the maker funds.
        setStep('Accepting…');
        const { data } = await oct.acceptDelayed(row.requestId, bid.bidId);
        push(`Accepted. Settles by ${new Date(data.scheduleSettlementTime).toLocaleString()}.`);
      } else {
        if (!txHash) throw new Error('No fill transaction was sent.');
        setStep('Recording fill…');
        await oct.recordFill({
          requestId: row.requestId,
          bidId: bid.bidId,
          txHash,
          filledAmount: bid.takerAmount,
          marketMaker: bid.marketMaker,
        });
        push(`Filled: ${txHash}`);
      }
      load();
    } catch (e) {
      push(e.message);
    } finally {
      setBusyRow('');
      setStep('');
    }
  };

  return (
    <section className="card">
      <div className="head">
        <h2>My auctions</h2>
        <button className="ghost" onClick={load}>Refresh</button>
      </div>

      <table>
        <thead>
          <tr><th>You sell</th><th>Best bid</th><th>Expires</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={5} className="empty">
              {account ? 'No auctions yet.' : 'Connect a wallet.'}
            </td></tr>
          )}
          {rows.map((row) => {
            // A txHash wins over `status`, which can lag a poll cycle after a
            // fill. Past that, the wall clock decides expiry — the backend's
            // expiry cron lags too, and an Accept button on a closed window
            // would just revert.
            const filled = !!row.txHash || row.status === 'filled';
            const left = Math.max(0, Math.floor((row.expiryTime || 0) - now / 1000));
            const state = filled ? 'accepted' : left <= 0 ? 'expired' : 'live';
            const bidAmt = row.bid && fmt(row.bid.makerAmount, row.bid.metadata?.redemptionAssetData?.decimals);

            return (
              <tr key={row.requestId}>
                <td>{n(row.sellToken.amount)} {row.sellToken.symbol}</td>
                <td>{bidAmt ? `${n(bidAmt)} ${row.buyToken.symbol}` : state === 'live' ? 'No bids yet' : '—'}</td>
                <td className={left > 0 && left < 3600 ? 'urgent' : ''}>
                  {state === 'live' ? countdown(left) : '—'}
                </td>
                <td><span className={`pill ${state}`}>{state}</span></td>
                <td className="right">
                  {state === 'live' && (
                    <button className="primary sm" disabled={!!busyRow || !row.bid}
                            onClick={() => accept(row)}>
                      {busyRow === row.requestId ? step : 'Accept'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
