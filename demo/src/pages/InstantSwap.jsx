import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { pollForBids } from '../api';
import { acceptBid } from '../lib/acceptBid';
import { cancelRequest, quoteBid, signRequest, txUrl } from '../lib/wallet';
import { fmt, horizon, n, parseRfqError, rate, short } from '../lib/format';
import AssetField from '../components/AssetField';
import BidDetails from '../components/BidDetails';
import Spinner from '../components/Spinner';
import SuccessMark from '../components/SuccessMark';

// Short window: this flow expects an answer now, not price discovery.
const EXPIRY_MINUTES = 10;
// Sets the signed terms when we don't send our own: the server turns it into
// the maximum rate (bps/day over the horizon) and the minimum payout.
const SLIPPAGE = 10;
// Bids drift with the oracle and the horizon, so re-price the one on screen.
const REQUOTE_MS = 15_000;

// Reverts that mean "this bid is no good any more", not "the request is":
// look for another bid on the same request.
const PICK_ANOTHER = new Set([
  'OrderExpired',
  'OrderIsCancelled',
  'OrderOverfilled',
  'MakerAmountTooHigh',
  'ReceivedBelowMinimum',
  'BpsPerDayTooHigh',
  'BpsPerDayAboveTakerCap',
  'DiscountExceedsPrincipal',
]);

/**
 * Swap now.
 *
 *   idle -> creating (POST /swap)
 *        -> signing  (user signs the request in the wallet, POST /swap/signature)
 *        -> waiting  (poll for bids)
 *        -> ready    (best bid on screen, re-quoted live, user decides)
 *        -> done     (filled, or approved for a delayed bid)
 *
 * The request stays live for EXPIRY_MINUTES either way, so "no bids yet" is
 * never fatal: the user can keep waiting, or cancel.
 */
function TxHash({ hash, chainId }) {
  const [copied, setCopied] = useState(false);
  const url = txUrl(chainId, hash);

  async function copy() {
    try {
      // The explorer link, so pasting it somewhere is immediately useful.
      // Falls back to the bare hash on a chain we have no explorer for.
      await navigator.clipboard.writeText(url || hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard needs a secure context and permission; the title attribute
      // below still lets the user select the full hash by hand.
    }
  }

  return (
    <div className="txhash" title={url || hash}>
      {url ? (
        <a className="mono" href={url} target="_blank" rel="noreferrer">{short(hash)}</a>
      ) : (
        <span className="mono">{short(hash)}</span>
      )}
      <button className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function toWei(amount, decimals) {
  try {
    return Number(amount) > 0 ? ethers.parseUnits(amount, decimals).toString() : null;
  } catch {
    return null; // more decimals than the token has
  }
}

export default function InstantSwap({ oct, account, chainId, rfq, tokens, sellable, stables, schedules }) {
  const [phase, setPhase] = useState('idle');
  const [sell, setSell] = useState(null);
  const [buy, setBuy] = useState(null);
  const [amount, setAmount] = useState('');
  const [over, setOver] = useState(false);
  const [estimate, setEstimate] = useState(0);

  const [request, setRequest] = useState(null); // POST /swap response
  const [signed, setSigned] = useState(false);
  const [bid, setBid] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [step, setStep] = useState('');
  const [result, setResult] = useState(null);

  const requestId = request?.requestId || '';
  const terms = request?.typedData?.message;
  const schedule = sell && schedules[sell.address.toLowerCase()];

  useEffect(() => {
    reset();
    setSell(null);
    setBuy(null);
  }, [chainId]);

  const wei = sell ? toWei(amount, sell.decimals) : null;

  // Free oracle quote so the buy field isn't blank while we wait for a bid.
  useEffect(() => {
    if (!sell || !buy || !wei) return setEstimate(0);
    oct
      .estimate({ chainId, redeemAsset: sell.address, redemptionAsset: buy.address, amount: wei })
      .then((d) => setEstimate(fmt(d.outputAmount, buy.decimals)))
      .catch(() => setEstimate(0));
  }, [oct, chainId, sell, buy, wei]);

  // Re-price the bid on screen with quoteRFQOrder, the view the fill itself
  // uses. A revert here (rate over a cap, no price) means it can't fill.
  useEffect(() => {
    if (!bid || phase !== 'ready') return;
    let dead = false;
    const run = () =>
      quoteBid(bid, chainId)
        .then((q) => {
          if (dead) return;
          setQuote(q);
          setQuoteError(q?.belowFloor ? 'This bid now pays less than your minimum.' : '');
        })
        .catch((e) => {
          if (dead) return;
          setQuote(null);
          setQuoteError(parseRfqError(e));
        });
    run();
    const t = setInterval(run, REQUOTE_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [bid, phase, chainId]);

  function reset() {
    setPhase('idle');
    setRequest(null);
    setSigned(false);
    setBid(null);
    setQuote(null);
    setQuoteError('');
    setResult(null);
    setStep('');
  }

  async function swap() {
    setPhase('creating');
    let created;
    try {
      created = await oct.createSwap({
        chainId,
        walletAddress: account,
        redeemAsset: sell.address,
        redemptionAsset: buy.address,
        amount: wei,
        expiry: EXPIRY_MINUTES,
        slippageTolerance: SLIPPAGE,
        swapType: 'direct',
      });
    } catch (e) {
      alert(e.message);
      return reset();
    }
    setRequest(created);

    if (created.signatureRequired === false) {
      setSigned(true);
      return waitForBids(created);
    }
    return sign(created);
  }

  // The signature is the user's consent to the trade. Bids can arrive before
  // it, but none can settle without it, so ask for it straight away.
  async function sign(req = request) {
    setPhase('signing');
    try {
      const signature = await signRequest(req.typedData, chainId, { rfq, account });
      await oct.submitRequestSignature(req.requestId, signature);
      setSigned(true);
    } catch (e) {
      alert(parseRfqError(e));
      setPhase('unsigned');
      return;
    }
    return waitForBids(req);
  }

  // Poll the request we already created. Creating another here would publish
  // a second RFQ for the same intent and leave the first one live.
  async function waitForBids(req = request) {
    setPhase('waiting');
    setBid(null);
    setQuote(null);
    const bids = req.bids?.length ? req.bids : await pollForBids(oct, req.requestId);
    if (!bids.length) {
      setPhase('empty');
      return;
    }
    setBid(bids[0]); // ranked lowest rate first = most for the user
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
      alert(parseRfqError(e));
      setStep('');
      if (e.rfqError === 'SaltIsCancelled') return reset();
      if (PICK_ANOTHER.has(e.rfqError) || /gone|expire|pick another/i.test(e.message)) {
        return waitForBids({ requestId });
      }
      setPhase('ready');
    }
  }

  // DELETE /request closes it off-chain and hands back cancelSalt(user, salt).
  // A signed request is only truly dead once that lands on-chain; an unsigned
  // one can never settle, so the API call is enough.
  async function cancel() {
    setPhase('cancelling');
    try {
      let cancelTx = null;
      try {
        ({ cancelTx } = await oct.cancelRequest(requestId));
      } catch {
        // Origin-allowlisted; build cancelSalt ourselves below.
      }
      if (signed) {
        await cancelRequest({ chainId, account, cancelTx, rfq, salt: terms?.salt, onStep: setStep });
      }
      reset();
    } catch (e) {
      alert(parseRfqError(e));
      setStep('');
      setPhase(signed ? 'empty' : 'unsigned');
    }
  }

  if (phase === 'done') {
    return (
      <div className="center-page">
        <section className="card narrow done">
          <SuccessMark />
          <Done result={result} sell={sell} buy={buy} terms={terms} />
          {result.txHash && <TxHash hash={result.txHash} chainId={chainId} />}
          <button className="primary block" onClick={reset}>Close</button>
        </section>
      </div>
    );
  }

  const busy = ['creating', 'signing', 'waiting', 'accepting', 'cancelling'].includes(phase);
  const buyDecimals = bid?.metadata?.redemptionAssetData?.decimals ?? buy?.decimals;
  const bidReceive = quote?.received ?? bid?.quotedNet;

  let label = 'Instant Redeem';
  if (!account) label = 'Connect wallet';
  else if (!rfq) label = 'Not available on this chain';
  else if (!sell || !buy) label = 'Select tokens';
  else if (!wei) label = 'Enter an amount';
  else if (over) label = `Not enough ${sell.symbol}`;
  else if (phase === 'creating') label = 'Creating request...';
  else if (phase === 'signing') label = 'Sign in wallet';
  else if (phase === 'waiting') label = 'Waiting for bids...';
  else if (phase === 'cancelling') label = step || 'Cancelling...';

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
          tokens={tokens}
          allowed={sellable}
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
          label={bid ? 'You receive (quote)' : 'You receive (oracle estimate)'}
          tokens={tokens}
          allowed={stables}
          token={buy}
          onToken={setBuy}
          exclude={sell}
          amount={bid ? (bidReceive != null ? n(fmt(bidReceive, buyDecimals)) : '') : estimate ? n(estimate) : ''}
          onAmount={() => {}}
          readOnly
        />

        {!bid && schedule && (
          <p className="hint">
            {sell.symbol} redeems in {horizon(schedule.horizonSeconds)}. Bidders quote a rate per day over
            that wait, up to {rate(schedule.maxBpsPerDay)}.
          </p>
        )}

        {/* Stays up through 'accepting' so the numbers the user agreed to are
            still on screen while they confirm in the wallet. */}
        {bid && (
          <BidDetails bid={bid} quote={quote} terms={terms} buySymbol={buy?.symbol} buyDecimals={buy?.decimals} />
        )}
        {bid && quoteError && <p className="hint warn">{quoteError}</p>}

        {phase === 'unsigned' && (
          <p className="hint">
            The request is created but not signed, so no bid can settle. Sign it, or discard it.
          </p>
        )}

        {phase === 'empty' && (
          <p className="hint">No bids yet. Keep waiting, or cancel the request.</p>
        )}

        {bid ? (
          // Same button through the whole accept: only the label changes, so
          // the bid details above never move.
          <button className="primary block" disabled={busy} onClick={accept}>
            {phase === 'accepting' && <Spinner />}
            {phase === 'accepting' ? step || 'Working...' : 'Accept bid'}
          </button>
        ) : phase === 'unsigned' ? (
          <button className="primary block" onClick={() => sign()}>Sign in wallet</button>
        ) : (
          <button
            className="primary block"
            disabled={!account || !rfq || !sell || !buy || !wei || over || busy}
            onClick={phase === 'empty' ? () => waitForBids() : swap}
          >
            {busy && <Spinner />}
            {phase === 'empty' ? 'Keep waiting' : label}
          </button>
        )}

        {(phase === 'empty' || phase === 'unsigned') && (
          <button className="ghost block" onClick={cancel}>
            {signed ? 'Cancel request' : 'Discard request'}
          </button>
        )}
      </section>
    </div>
  );
}

// What actually happened, from the RFQOrderFilled event rather than the quote.
function Done({ result, sell, buy, terms }) {
  const buyDecimals = result.bid?.metadata?.redemptionAssetData?.decimals ?? buy?.decimals;
  const sellDecimals = result.bid?.metadata?.redeemAssetData?.decimals ?? sell?.decimals;

  if (result.settlement === 'delayed') {
    const floor = result.quote?.floor ?? terms?.minReceivedAmount;
    return (
      <>
        <h2>Bid accepted</h2>
        <p className="sub">
          Octarine fills this bid with your signed request
          {result.settlesBy ? ` by about ${new Date(result.settlesBy).toLocaleString()}` : ' once the bidder funds'}.
          {floor != null && ` You receive at least ${n(fmt(floor, buyDecimals))} ${buy?.symbol}.`}
        </p>
      </>
    );
  }

  const f = result.filled;
  if (!f) {
    return (
      <>
        <h2>Redemption processed</h2>
        <p className="sub">Your swap has settled on-chain.</p>
      </>
    );
  }
  return (
    <>
      <h2>Redemption processed</h2>
      <p className="sub">
        Sold {n(fmt(f.takerAmountFilled, sellDecimals))} {sell?.symbol} for{' '}
        <strong>{n(fmt(f.received, buyDecimals))} {buy?.symbol}</strong>.
      </p>
      <dl className="rows">
        <div><dt>Fee</dt><dd>{n(fmt(f.fee, buyDecimals))} {buy?.symbol}</dd></div>
        {f.makerBpsPerDay != null && <div><dt>Rate</dt><dd>{rate(f.makerBpsPerDay)}</dd></div>}
        {f.horizonSeconds != null && <div><dt>Horizon</dt><dd>{horizon(f.horizonSeconds)}</dd></div>}
      </dl>
    </>
  );
}
