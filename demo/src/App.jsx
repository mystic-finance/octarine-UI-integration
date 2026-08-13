import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { api } from './api';
import { connectWallet } from './lib/wallet';
import { short } from './lib/format';
import InstantSwap from './pages/InstantSwap';
import Auctions from './pages/Auctions';

// The demo runs on Sepolia only. Widen this list, or drop the filter below,
// to offer everything GET /chains returns.
const ALLOWED_CHAINS = [11155111];
const DEFAULT_CHAIN = 11155111;

export default function App() {
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(DEFAULT_CHAIN);
  const [chains, setChains] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [redemptionTimes, setRedemptionTimes] = useState({});
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

  // `T+N` per asset. Chain-scoped, so refetch when the chain changes.
  useEffect(() => {
    let dead = false;
    oct
      .redemptionTimes(chainId)
      .then((r) => !dead && setRedemptionTimes(r || {}))
      .catch(() => !dead && setRedemptionTimes({}));
    return () => {
      dead = true;
    };
  }, [oct, chainId]);

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

  const shared = { oct, account, chainId, tokens, redemptionTimes };

  return (
    <div className="app">
      <header>
        <h1>Octarine Frontend Integration Demo</h1>

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

      {loadError && (
        <div className="banner">
          <span>Could not reach the Octarine API: {loadError}</span>
          <button className="ghost" onClick={loadReference}>Retry</button>
        </div>
      )}

      <Routes>
        <Route path="/" element={<InstantSwap {...shared} />} />
        <Route path="/auctions" element={<Auctions {...shared} />} />
      </Routes>
    </div>
  );
}
