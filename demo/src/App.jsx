import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { api } from './api';
import { connectWallet } from './lib/wallet';
import { short } from './lib/format';
import InstantSwap from './pages/InstantSwap';
import Auctions from './pages/Auctions';

export default function App() {
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(98866); // Plume mainnet
  const [chains, setChains] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [loadError, setLoadError] = useState('');

  const oct = useMemo(() => api(), []);

  const loadReference = useCallback(() => {
    setLoadError('');
    Promise.all([oct.chains(), oct.tokens()])
      .then(([c, t]) => {
        setChains(c);
        setTokens(t);
      })
      // Inline, not an alert. A blocking popup on first paint is a poor
      // greeting for what is usually a transient network blip.
      .catch((e) => setLoadError(e.message));
  }, [oct]);

  useEffect(loadReference, [loadReference]);

  async function connect() {
    try {
      const w = await connectWallet();
      setAccount(w.account);
      setChainId(w.chainId);
    } catch (e) {
      alert(e.message);
    }
  }

  const shared = { oct, account, chainId, tokens };

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
