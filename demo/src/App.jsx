import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { connectWallet, readSchedules } from './lib/wallet';
import { short } from './lib/format';
import InstantSwap from './pages/InstantSwap';
import Auctions from './pages/Auctions';
import LegacyMigration, { LegacyBanner, useLegacyScan } from './components/LegacyMigration';

// The demo runs on Sepolia only. Widen this list, or drop the filter below,
// to offer everything GET /chains returns.
const ALLOWED_CHAINS = [11155111];
const DEFAULT_CHAIN = 11155111;

export default function App() {
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(DEFAULT_CHAIN);
  const [chains, setChains] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [schedules, setSchedules] = useState({});
  const [loadError, setLoadError] = useState('');

  const oct = useMemo(() => api(), []);

  const loadReference = useCallback(() => {
    setLoadError('');
    Promise.all([oct.chains(), oct.tokens()])
      .then(([c, t]) => {
        setChains(c.filter((x) => ALLOWED_CHAINS.includes(x.chainId)));
        setTokens(t);
      })
      // Inline, not an alert. A blocking popup on first paint is a poor
      // greeting for what is usually a transient network blip.
      .catch((e) => setLoadError(e.message));
  }, [oct]);

  useEffect(loadReference, [loadReference]);

  // The OctarineRFQ on this chain: the EIP-712 verifyingContract the user
  // signs for, and the approval spender. Never hard-code it.
  const rfq = chains.find((c) => c.chainId === chainId)?.rfq || '';

  const chainTokens = useMemo(() => tokens.filter((t) => t.chainId === chainId), [tokens, chainId]);

  // Only RFQ-listed RWAs can be sold, only for stablecoins. "Listed" means the
  // RFQ has a redemption schedule for it, which is also what prices the fill,
  // so read it off the contract. Chain-scoped: refetch when the chain changes.
  useEffect(() => {
    setSchedules({});
    if (!rfq || !chainTokens.length) return;
    let dead = false;
    const candidates = chainTokens.filter((t) => !t.isStable).map((t) => t.address);
    readSchedules(rfq, candidates, chainId)
      .then((s) => !dead && setSchedules(s))
      .catch(() => !dead && setSchedules({}));
    return () => {
      dead = true;
    };
  }, [rfq, chainTokens, chainId]);

  const sellable = useMemo(
    () => new Set(Object.entries(schedules).filter(([, s]) => !s.halted).map(([a]) => a)),
    [schedules],
  );

  // What you can receive. If the registry carries no isStable flags on this
  // chain, fall back to every token that isn't an RFQ-listed RWA; the server
  // still rejects a pair the RFQ can't price.
  const stables = useMemo(() => {
    const flagged = chainTokens.filter((t) => t.isStable);
    const list = flagged.length ? flagged : chainTokens.filter((t) => !schedules[t.address.toLowerCase()]);
    return new Set(list.map((t) => t.address.toLowerCase()));
  }, [chainTokens, schedules]);

  // Follow the wallet. Without this the selector keeps pointing at the old
  // chain after the user switches in MetaMask, and anything reading on-chain
  // (balances) stays stuck against a network the tokens don't exist on.
  useEffect(() => {
    if (!window.ethereum) return;
    const onChain = (hex) => {
      const id = Number(BigInt(hex));
      if (ALLOWED_CHAINS.includes(id)) setChainId(id);
    };
    const onAccounts = (accounts) => setAccount(accounts[0] || '');
    window.ethereum.on('chainChanged', onChain);
    window.ethereum.on('accountsChanged', onAccounts);
    return () => {
      window.ethereum.removeListener('chainChanged', onChain);
      window.ethereum.removeListener('accountsChanged', onAccounts);
    };
  }, []);

  async function connect() {
    try {
      const w = await connectWallet();
      setAccount(w.account);
      if (ALLOWED_CHAINS.includes(w.chainId)) setChainId(w.chainId);
    } catch (e) {
      alert(e.message);
    }
  }

  const shared = { oct, account, chainId, rfq, tokens: chainTokens, sellable, stables, schedules };

  // Leftovers from the v1 Octarine contract:
  // approvals to revoke, open requests that can no longer settle. The banner
  // points at /migrate whenever there is anything to clean up.
  const legacy = useLegacyScan({ oct, account, chainId, tokens: chainTokens });
  const onMigrate = useLocation().pathname === '/migrate';

  return (
    <div className="app">
      <header>
        <h1>Octarine Frontend Integration Demo</h1>

        <div className="bar">
          <Link className="ghost" to={onMigrate ? '/' : '/migrate'}>{onMigrate ? 'Swap' : 'Migrate'}</Link>
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

      {loadError && (
        <div className="banner">
          <span>Could not reach the Octarine API: {loadError}</span>
          <button className="ghost" onClick={loadReference}>Retry</button>
        </div>
      )}

      {!loadError && chains.length > 0 && !rfq && (
        <div className="banner">
          <span>Octarine RFQ is not deployed on this chain yet.</span>
        </div>
      )}

      {!onMigrate && <LegacyBanner scan={legacy} />}

      <Routes>
        <Route path="/" element={<InstantSwap {...shared} />} />
        <Route path="/auctions" element={<Auctions {...shared} />} />
        <Route path="/migrate" element={<LegacyMigration {...shared} scan={legacy} />} />
      </Routes>
    </div>
  );
}
