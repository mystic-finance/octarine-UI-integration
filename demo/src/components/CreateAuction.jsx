import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { signRequest } from '../lib/wallet';
import { fmt, horizon, n, parseRfqError, rate, suggestedMinimum, toHumanRate, when } from '../lib/format';
import AssetField from './AssetField';
import Spinner from './Spinner';

const DURATIONS = [
  { minutes: 60, label: '1h' },
  { minutes: 1440, label: '1d' },
  { minutes: 10080, label: '7d' },
];

function toWei(amount, decimals) {
  try {
    return Number(amount) > 0 ? ethers.parseUnits(amount, decimals).toString() : null;
  } catch {
    return null;
  }
}

/**
 * Same POST /swap as the instant page. The differences are the long expiry,
 * fullAuctionEnabled (which puts it on the board and in My auctions), and that
 * the user states their own terms instead of letting slippage derive them:
 *
 *   - minimum you'll accept -> minReceivedAmount, the signed floor on proceeds
 *   - max rate (bps/day)    -> takerMaxBpsPerDay, the most discount per day
 *
 * Three steps: create (server builds the request), sign (wallet), publish
 * (POST /swap/signature). The fee is the server's; it is shown, not chosen.
 */
export default function CreateAuction({ oct, account, chainId, rfq, tokens, sellable, stables, schedules, onCreated }) {
  const [sell, setSell] = useState(null);
  const [buy, setBuy] = useState(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState(1440);
  const [minAccept, setMinAccept] = useState('');
  const [maxRate, setMaxRate] = useState('');
  const [over, setOver] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [busy, setBusy] = useState('');
  const [created, setCreated] = useState(null); // POST /swap response awaiting signature

  useEffect(() => {
    setSell(null);
    setBuy(null);
    setCreated(null);
  }, [chainId]);

  const wei = sell ? toWei(amount, sell.decimals) : null;
  const schedule = sell && schedules[sell.address.toLowerCase()];

  useEffect(() => {
    if (!sell || !buy || !wei) return setEstimate(null);
    oct
      .estimate({ chainId, redeemAsset: sell.address, redemptionAsset: buy.address, amount: wei })
      .then(setEstimate)
      .catch(() => setEstimate(null));
  }, [oct, chainId, sell, buy, wei]);

  // Fee is set by the server (Octarine's per-asset rate over the horizon, plus
  // any referral). Shown when the estimate carries it, and always in the
  // terms before signing.
  const feeBps = created?.typedData?.message?.feeBps ?? estimate?.feeBps;

  // A starting point for the floor: the oracle value at the highest rate the
  // user will take, less the fee.
  const capRate = Number(maxRate) > 0 ? Number(maxRate) : schedule?.maxBpsPerDay;
  const suggested =
    estimate && buy && schedule && capRate
      ? fmt(suggestedMinimum(estimate.outputAmount, capRate, schedule.horizonSeconds, feeBps || 0), buy.decimals)
      : 0;

  const minWei = buy && minAccept ? toWei(minAccept, buy.decimals) : null;
  const rateTooHigh = schedule && Number(maxRate) > schedule.maxBpsPerDay;

  async function create() {
    setBusy('Creating');
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
        ...(minWei && { minReceivedAmount: minWei }),
        ...(Number(maxRate) > 0 && { takerMaxBpsPerDay: Number(maxRate) }),
      });
      if (r.signatureRequired === false) return published(r.requestId);
      setCreated(r); // show the terms; the user signs from there
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  async function sign() {
    setBusy('Sign in wallet');
    try {
      const signature = await signRequest(created.typedData, chainId, { rfq, account });
      setBusy('Publishing');
      await oct.submitRequestSignature(created.requestId, signature);
      published(created.requestId);
    } catch (e) {
      alert(parseRfqError(e));
    } finally {
      setBusy('');
    }
  }

  // Unsigned, so nothing on-chain can settle it; closing the row is enough.
  async function discard() {
    const id = created.requestId;
    setCreated(null);
    try {
      await oct.cancelRequest(id);
    } catch {
      // Origin-allowlisted. It expires unsigned, which is harmless.
    }
    onCreated();
  }

  function published(requestId) {
    alert(`Auction published.\n\n${requestId}`);
    setCreated(null);
    setAmount('');
    setMinAccept('');
    onCreated();
  }

  let label = 'Create auction';
  if (busy) label = busy;
  else if (!account) label = 'Connect wallet';
  else if (!rfq) label = 'Not available on this chain';
  else if (!wei) label = 'Enter an amount';
  else if (over) label = `Not enough ${sell.symbol}`;

  if (created) {
    return (
      <section className="card">
        <h2>Sign your auction</h2>
        <p className="sub">
          Your signature is your consent to these terms. Bidders compete on rate; whichever bid you accept
          pays at least your minimum.
        </p>
        <Terms created={created} sell={sell} buy={buy} />
        <button className="primary block" disabled={!!busy} onClick={sign}>
          {!!busy && <Spinner />}
          {busy || 'Sign in wallet'}
        </button>
        <button className="ghost block" disabled={!!busy} onClick={discard}>Discard</button>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Create auction</h2>

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
        label="You receive (oracle estimate)"
        tokens={tokens}
        allowed={stables}
        token={buy}
        onToken={setBuy}
        exclude={sell}
        amount={estimate ? n(fmt(estimate.outputAmount, buy?.decimals)) : ''}
        onAmount={() => {}}
        readOnly
      />

      <label>Minimum you'll accept{buy ? ` (${buy.symbol})` : ''}</label>
      <input
        className="amt"
        placeholder={suggested ? `e.g. ${n(suggested, 2)}` : 'Derived from slippage if empty'}
        value={minAccept}
        onChange={(e) => setMinAccept(e.target.value.replace(/[^0-9.]/g, ''))}
      />

      <label>Max rate (bps/day)</label>
      <input
        className="amt"
        placeholder={schedule ? `Asset max ${schedule.maxBpsPerDay}` : 'Derived from slippage if empty'}
        value={maxRate}
        onChange={(e) => setMaxRate(e.target.value.replace(/[^0-9.]/g, ''))}
      />
      {rateTooHigh && (
        <p className="hint warn">
          Above this asset's maximum of {rate(schedule.maxBpsPerDay)}; no bid can fill above that anyway.
        </p>
      )}

      <dl className="rows terms">
        {schedule && (
          <div><dt>Redeems in</dt><dd>{horizon(schedule.horizonSeconds)}</dd></div>
        )}
        <div>
          <dt>Fee</dt>
          <dd>{feeBps != null ? `${feeBps} bps` : 'Set by Octarine, shown before you sign'}</dd>
        </div>
      </dl>

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
        disabled={!account || !rfq || !sell || !buy || !wei || over || !!busy}
        onClick={create}
      >
        {!!busy && <Spinner />}
        {label}
      </button>

      <p className="hint">
        Solvers bid a rate over the window you pick. Accept the one you want from My auctions.
      </p>
    </section>
  );
}

// The signed terms, read back from the typed data the wallet will show.
function Terms({ created, sell, buy }) {
  const m = created.typedData?.message || {};
  return (
    <dl className="rows">
      <div><dt>You sell</dt><dd>{n(fmt(m.takerAmount, sell?.decimals))} {sell?.symbol}</dd></div>
      <div><dt>Minimum you'll accept</dt><dd>{n(fmt(m.minReceivedAmount, buy?.decimals))} {buy?.symbol}</dd></div>
      <div><dt>Max rate</dt><dd>{rate(toHumanRate(m.takerMaxBpsPerDay))}</dd></div>
      <div><dt>Fee</dt><dd>{m.feeBps} bps</dd></div>
      <div><dt>Valid until</dt><dd>{when(m.expiry)}</dd></div>
    </dl>
  );
}
