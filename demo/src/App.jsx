import { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { api } from './api';

const APPROVE_ABI = ['function approve(address,uint256)'];
const ALLOWANCE_ABI = ['function allowance(address,address) view returns (uint256)'];
const BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

const DURATIONS = [
  { minutes: 60, label: '1h' },
  { minutes: 1440, label: '1d' },
  { minutes: 10080, label: '7d' },
];

function fmt(raw, decimals = 18) {
  try {
    return Number(ethers.formatUnits(BigInt(raw ?? 0), Number(decimals) || 18));
  } catch {
    return 0;
  }
}

function n(v, maxFrac = 4) {
  const x = Number(v);
  return Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: maxFrac }) : '—';
}

const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '—');

function countdown(s) {
  if (s <= 0) return 'Expired';
  if (s > 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s > 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Bid calldata is built for one chain. The wallet won't always be on it, so
// switch first, then check again before we hand back a signer.
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

// Sends bid.txns in order, returns the hash of the last one.
// Empty string if we skipped everything, which is fine for a delayed bid
// that's already approved but not for an instant fill.
async function executeBid(bid, chainId, owner, onStep) {
  const signer = await signerOn(chainId);
  let hash = '';

  for (const tx of bid.txns) {
    const isApproval = tx.type?.toLowerCase().includes('approv');

    if (isApproval) {
      // Don't re-prompt if the allowance already covers it. Some tokens also
      // revert going from one non-zero allowance straight to another.
      const [spender, needed] = new ethers.Interface(APPROVE_ABI).decodeFunctionData('approve', tx.data);
      const token = new ethers.Contract(tx.to, ALLOWANCE_ABI, signer);
      if ((await token.allowance(owner, spender)) >= BigInt(needed)) continue;
    }

    onStep(isApproval ? 'Approve in wallet' : 'Confirm in wallet');
    const sent = await signer.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value || undefined,
    });
    await sent.wait();
    hash = sent.hash;
  }

  return hash;
}

export default function App() {
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(98866);
  const [chains, setChains] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [reload, setReload] = useState(0);

  const oct = useMemo(() => api(), []);

  useEffect(() => {
    Promise.all([oct.chains(), oct.tokens()])
      .then(([c, t]) => {
        setChains(c);
        setTokens(t);
      })
      .catch((e) => alert(e.message));
  }, [oct]);

  async function connect() {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      setAccount(await signer.getAddress());
      setChainId(Number((await provider.getNetwork()).chainId));
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Octarine UI demo</h1>
        <div className="bar">
          <select value={chainId} onChange={(e) => setChainId(Number(e.target.value))}>
            {chains.map((c) => (
              <option key={c.chainId} value={c.chainId}>{c.name}</option>
            ))}
          </select>
          {account ? (
            <span className="badge">{short(account)}</span>
          ) : (
            <button className="primary" onClick={connect}>Connect wallet</button>
          )}
        </div>
      </header>

      <div className="columns">
        <Swap
          oct={oct}
          account={account}
          chainId={chainId}
          tokens={tokens}
          onDone={() => setReload((r) => r + 1)}
        />
        <MyAuctions oct={oct} account={account} chainId={chainId} reload={reload} />
      </div>
    </div>
  );
}

function Swap({ oct, account, chainId, tokens, onDone }) {
  const [sell, setSell] = useState(null);
  const [buy, setBuy] = useState(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState(1440);
  const [out, setOut] = useState(0);
  const [balance, setBalance] = useState(null);
  const [busy, setBusy] = useState('');

  const list = useMemo(() => tokens.filter((t) => t.chainId === chainId), [tokens, chainId]);

  useEffect(() => {
    setSell(null);
    setBuy(null);
  }, [chainId]);

  const wei = sell && Number(amount) > 0 ? ethers.parseUnits(amount, sell.decimals).toString() : null;

  useEffect(() => {
    if (!sell || !buy || !wei) return setOut(0);
    oct
      .estimate({ chainId, redeemAsset: sell.address, redemptionAsset: buy.address, amount: wei })
      .then((d) => setOut(fmt(d.outputAmount, buy.decimals)))
      .catch(() => setOut(0));
  }, [oct, chainId, sell, buy, wei]);

  // Don't let people auction what they don't hold, market makers would bid on
  // it and the fill would revert at settlement. Reads off the wallet's current
  // chain, so it's stale until the wallet switches to the one selected above.
  useEffect(() => {
    if (!account || !sell || !window.ethereum) return setBalance(null);
    let dead = false;
    const provider = new ethers.BrowserProvider(window.ethereum);
    new ethers.Contract(sell.address, BALANCE_ABI, provider)
      .balanceOf(account)
      .then((b) => !dead && setBalance(b))
      .catch(() => !dead && setBalance(null));
    return () => {
      dead = true;
    };
  }, [account, sell, chainId]);

  const overBalance = balance !== null && wei !== null && BigInt(wei) > balance;

  async function createAuction() {
    setBusy('Placing');
    try {
      const r = await oct.createSwap({
        chainId,
        walletAddress: account,
        redeemAsset: sell.address,
        redemptionAsset: buy.address,
        amount: wei,
        expiry: duration, // minutes
        slippageTolerance: 10,
        swapType: 'direct',
        fullAuctionEnabled: true,
      });
      alert(`Auction created.\n\n${r.requestId}`);
      setAmount('');
      onDone();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  let label = 'Create auction';
  if (busy) label = busy;
  else if (!account) label = 'Connect wallet';
  else if (!wei) label = 'Enter an amount';
  else if (overBalance) label = `Not enough ${sell.symbol}`;

  return (
    <section className="card">
      <h2>Swap</h2>

      <div className="label-row">
        <label>You sell</label>
        {balance !== null && sell && (
          <button
            className="max"
            onClick={() => setAmount(ethers.formatUnits(balance, sell.decimals))}
          >
            Balance {n(fmt(balance, sell.decimals))}
          </button>
        )}
      </div>
      <div className={overBalance ? 'row bad' : 'row'}>
        <input
          className="amt"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
        />
        <Picker list={list} value={sell} onChange={setSell} exclude={buy} />
      </div>

      <label>You receive (oracle estimate)</label>
      <div className="row">
        <input className="amt out" readOnly placeholder="0.0" value={out ? n(out) : ''} />
        <Picker list={list} value={buy} onChange={setBuy} exclude={sell} />
      </div>

      <label>Auction duration</label>
      <div className="segs">
        {DURATIONS.map((d) => (
          <button
            key={d.minutes}
            className={duration === d.minutes ? 'seg on' : 'seg'}
            onClick={() => setDuration(d.minutes)}
          >
            {d.label}
          </button>
        ))}
      </div>

      <button
        className="primary block"
        disabled={!account || !sell || !buy || !wei || overBalance || !!busy}
        onClick={createAuction}
      >
        {label}
      </button>

      <p className="hint">
        Market makers bid over the window you pick. Accept the best one from My auctions.
      </p>
    </section>
  );
}

function Picker({ list, value, onChange, exclude }) {
  return (
    <select
      value={value?.address || ''}
      onChange={(e) => onChange(list.find((t) => t.address === e.target.value) || null)}
    >
      <option value="">Token</option>
      {list
        .filter((t) => t.address !== exclude?.address)
        .map((t) => (
          <option key={t.address} value={t.address}>{t.symbol}</option>
        ))}
    </select>
  );
}


function MyAuctions({ oct, account, chainId, reload }) {
  const [rows, setRows] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [openRow, setOpenRow] = useState(null);

  const load = useCallback(async () => {
    if (!account) return setRows([]);
    try {
      // No status filter, so this is the full history. Add open=true for only
      // the rows the user can still act on, or status='filled,expired' etc.
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
                    <button
                      className="primary sm"
                      disabled={!row.bid}
                      onClick={() => setOpenRow(row)}
                    >
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

function settlementLabel(bid) {
  if (bid.settlementType !== 'delayed') return 'Instant';
  const hours = Math.round((bid.estimatedSettlementTime || 0) / 3600);
  if (!hours) return 'Delayed';
  return hours >= 24 ? `Delayed ~${Math.round(hours / 24)}d` : `Delayed ~${hours}h`;
}

function BidsModal({ oct, account, row, onClose, onDone }) {
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
    setStep('Loading bid');
    try {
      // Re-read even though we just listed them. The execute txn carries a
      // nonce that moves when any other order settles, so the calldata we
      // rendered a minute ago is probably stale by now.
      const fresh = await oct.swapStatus(row.requestId);
      const match = (fresh.bids || []).find((b) => b.bidId === bid.bidId);
      if (!match) throw new Error('That bid is gone. Refreshing the list.');
      if (!match.txns?.length) throw new Error('Settlement busy, try again in a few seconds.');

      // row.chainId, not the chain the app happens to be showing
      const txHash = await executeBid(match, row.chainId, account, setStep);

      if (match.settlementType === 'delayed') {
        // txns was the approval only. This locks the bid and Octarine fills it
        // once the maker funds.
        setStep('Accepting');
        const { data } = await oct.acceptDelayed(row.requestId, match.bidId);
        alert(`Accepted.\n\nSettles by ${new Date(data.scheduleSettlementTime).toLocaleString()}.`);
      } else {
        if (!txHash) throw new Error('No fill transaction was sent.');
        setStep('Recording fill');
        await oct.recordFill({
          requestId: row.requestId,
          bidId: match.bidId,
          txHash,
          filledAmount: match.takerAmount,
          marketMaker: match.marketMaker,
        });
        alert(`Filled.\n\n${txHash}`);
      }

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
                <th>Market maker</th>
                <th>You receive</th>
                <th>Settlement</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bids.map((bid) => {
                const decimals = bid.metadata?.redemptionAssetData?.decimals;
                return (
                  <tr key={bid.bidId}>
                    <td title={bid.marketMaker}>
                      {bid.marketMakerName || short(bid.marketMaker)}
                      {bid.trustScore != null && (
                        <div className="muted">Trust score: {bid.trustScore}/100</div>
                      )}
                    </td>
                    <td>
                      <strong className="bid">
                        {n(fmt(bid.makerAmount, decimals))} {row.buyToken.symbol}
                      </strong>
                      {bid.networkCostUSD != null && (
                        <div className="muted">gas ~${bid.networkCostUSD}</div>
                      )}
                    </td>
                    <td>{settlementLabel(bid)}</td>
                    <td className="right">
                      <button
                        className="primary sm"
                        disabled={!!busyBid}
                        onClick={() => accept(bid)}
                      >
                        {busyBid === bid.bidId ? step : 'Accept bid'}
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
