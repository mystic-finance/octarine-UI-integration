import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { fmt, n } from '../lib/format';
import AssetField from './AssetField';

const DURATIONS = [
  { minutes: 60, label: '1h' },
  { minutes: 1440, label: '1d' },
  { minutes: 10080, label: '7d' },
];

// Same POST /swap as the instant page. The difference is the long expiry and
// fullAuctionEnabled, which is what puts it on the board and in My auctions.
export default function CreateAuction({ oct, account, chainId, tokens, onCreated }) {
  const [sell, setSell] = useState(null);
  const [buy, setBuy] = useState(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState(1440);
  const [over, setOver] = useState(false);
  const [estimate, setEstimate] = useState(0);
  const [busy, setBusy] = useState('');

  const list = useMemo(() => tokens.filter((t) => t.chainId === chainId), [tokens, chainId]);

  useEffect(() => {
    setSell(null);
    setBuy(null);
  }, [chainId]);

  const wei = sell && Number(amount) > 0 ? ethers.parseUnits(amount, sell.decimals).toString() : null;

  useEffect(() => {
    if (!sell || !buy || !wei) return setEstimate(0);
    oct
      .estimate({ chainId, redeemAsset: sell.address, redemptionAsset: buy.address, amount: wei })
      .then((d) => setEstimate(fmt(d.outputAmount, buy.decimals)))
      .catch(() => setEstimate(0));
  }, [oct, chainId, sell, buy, wei]);

  async function create() {
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
      onCreated();
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
  else if (over) label = `Not enough ${sell.symbol}`;

  return (
    <section className="card">
      <h2>Create auction</h2>

      <AssetField
        label="You sell"
        tokens={list}
        token={sell}
        onToken={setSell}
        exclude={buy}
        amount={amount}
        onAmount={setAmount}
        account={account}
        chainId={chainId}
        showBalance
        onOverBalance={setOver}
      />

      <AssetField
        label="You receive (oracle estimate)"
        tokens={list}
        token={buy}
        onToken={setBuy}
        exclude={sell}
        amount={estimate ? n(estimate) : ''}
        onAmount={() => {}}
        readOnly
      />

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
        disabled={!account || !sell || !buy || !wei || over || !!busy}
        onClick={create}
      >
        {label}
      </button>

      <p className="hint">
        Bidders bid over the window you pick. Accept the one you want from My auctions.
      </p>
    </section>
  );
}
