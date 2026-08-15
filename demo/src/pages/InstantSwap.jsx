import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { pollForBids } from '../api';
import { acceptBid } from '../lib/acceptBid';
import { fmt, n, short } from '../lib/format';
import AssetField from '../components/AssetField';
import BidDetails from '../components/BidDetails';

// Short window: this flow expects an answer now, not price discovery.
const EXPIRY_MINUTES = 10;
const SLIPPAGE = 10;

/**
 * Swap now.
 *
 *   idle -> waiting (create the request, poll for bids)
 *        -> ready   (best bid on screen, user decides)
 *        -> done    (accepted)
 *
 * The request stays live for EXPIRY_MINUTES either way, so "no bids yet" is
 * never fatal: the user can keep waiting, or create an auction instead.
 */
function TxHash({ hash }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard needs a secure context and permission; the title attribute
      // below still lets the user select the full hash by hand.
    }
  }

  return (
    <div className="txhash" title={hash}>
      <span className="mono">{short(hash)}</span>
      <button className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

export default function InstantSwap({ oct, account, chainId, tokens, redemptionTimes }) {
  const [phase, setPhase] = useState('idle');
  const [sell, setSell] = useState(null);
  const [buy, setBuy] = useState(null);
  const [amount, setAmount] = useState('');
  const [over, setOver] = useState(false);
  const [estimate, setEstimate] = useState(0);

  const [requestId, setRequestId] = useState('');
  const [bid, setBid] = useState(null);
  const [step, setStep] = useState('');
  const [result, setResult] = useState(null);

  const list = useMemo(() => tokens.filter((t) => t.chainId === chainId), [tokens, chainId]);

  useEffect(() => {
    reset();
    setSell(null);
    setBuy(null);
  }, [chainId]);

  const wei = sell && Number(amount) > 0 ? ethers.parseUnits(amount, sell.decimals).toString() : null;

  // Free oracle quote so the buy field isn't blank while we wait for a bid.
  useEffect(() => {
    if (!sell || !buy || !wei) return setEstimate(0);
    oct
      .estimate({ chainId, redeemAsset: sell.address, redemptionAsset: buy.address, amount: wei })
      .then((d) => setEstimate(fmt(d.outputAmount, buy.decimals)))
      .catch(() => setEstimate(0));
  }, [oct, chainId, sell, buy, wei]);

  function reset() {
    setPhase('idle');
    setRequestId('');
    setBid(null);
    setResult(null);
    setStep('');
  }

  async function swap() {
    setPhase('waiting');
    try {
      const request = await oct.createSwap({
        chainId,
        walletAddress: account,
        redeemAsset: sell.address,
        redemptionAsset: buy.address,
        amount: wei,
        expiry: EXPIRY_MINUTES,
        slippageTolerance: SLIPPAGE,
        swapType: 'direct',
      });
      setRequestId(request.requestId);

      // POST /swap already held the connection open for a moment, so a fast
      // solver is in the response. Poll the same requestId for the rest.
      const bids = request.bids?.length ? request.bids : await pollForBids(oct, request.requestId);

      if (!bids.length) {
        setPhase('empty');
        return;
      }
      setBid(bids[0]); // ranked best first
      setPhase('ready');
    } catch (e) {
      alert(e.message);
      reset();
    }
  }

  // Poll the request we already created. Calling swap() again here would
  // publish a second RFQ for the same intent and leave the first one live.
  async function keepWaiting() {
    setPhase('waiting');
    const bids = await pollForBids(oct, requestId);
    if (!bids.length) {
      setPhase('empty');
      return;
    }
    setBid(bids[0]);
    setPhase('ready');
  }

  async function accept() {
    setPhase('accepting');
    try {
      const res = await acceptBid({
        oct,
        requestId,
        chainId,
        account,
        bidId: bid.bidId,
        onStep: setStep,
      });
      setResult(res);
      setPhase('done');
      setAmount('');
    } catch (e) {
      alert(e.message);
      setPhase('ready');
      setStep('');
    }
  }

  if (phase === 'done') {
    return (
      <div className="center-page">
        <section className="card narrow">
          <h2>Swap complete</h2>
          <p className="sub">
            {result.settlement === 'delayed'
              ? `Accepted. Settles by ${new Date(result.settlesBy).toLocaleString()}.`
              : 'Your swap settled on-chain.'}
          </p>
          {result.txHash && <TxHash hash={result.txHash} />}
          <button className="primary block" onClick={reset}>Close</button>
        </section>
      </div>
    );
  }

  const busy = phase === 'waiting' || phase === 'accepting';

  let label = 'Instant Redeem';
  if (!account) label = 'Connect wallet';
  else if (!sell || !buy) label = 'Select tokens';
  else if (!wei) label = 'Enter an amount';
  else if (over) label = `Not enough ${sell.symbol}`;
  else if (phase === 'waiting') label = 'Waiting for bids...';

  return (
    <div className="center-page">
      <p className="faucet">
        Need test tokens?{' '}
        <a href="https://staging.octarine.finance/faucet" target="_blank" rel="noreferrer">
          Get them from this faucet
        </a>
      </p>

      <section className="card narrow">
        <h2>Instant Redeem</h2>

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
          label={bid ? 'You receive (firm bid)' : 'You receive (oracle estimate)'}
          tokens={list}
          token={buy}
          onToken={setBuy}
          exclude={sell}
          amount={
            bid
              ? n(fmt(bid.makerAmount, bid.metadata?.redemptionAssetData?.decimals ?? buy?.decimals))
              : estimate ? n(estimate) : ''
          }
          onAmount={() => {}}
          readOnly
        />

        {/* Stays up through 'accepting' so the numbers the user agreed to are
            still on screen while they confirm in the wallet. */}
        {bid && (
          <BidDetails
            bid={bid}
            buySymbol={buy?.symbol}
            sellSymbol={sell?.symbol}
            redemptionTime={redemptionTimes[sell?.address?.toLowerCase()]}
          />
        )}

        {/* {phase === 'waiting' && (
          <p className="hint">
            Swap request is live for {EXPIRY_MINUTES} minutes. Waiting for a solver to quote it...
          </p>
        )} */}

        {phase === 'empty' && (
          <p className="hint">
            No bids yet. Keep waiting or create another auction.
          </p>
        )}

        {bid ? (
          // Same button through the whole accept: only the label changes, so
          // the bid details above never move.
          <button className="primary block" disabled={busy} onClick={accept}>
            {phase === 'accepting' ? step || 'Working...' : 'Accept bid'}
          </button>
        ) : (
          <button
            className="primary block"
            disabled={!account || !sell || !buy || !wei || over || busy}
            onClick={phase === 'empty' ? keepWaiting : swap}
          >
            {phase === 'empty' ? 'Keep waiting' : label}
          </button>
        )}
      </section>
    </div>
  );
}
