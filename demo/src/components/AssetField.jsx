import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { readBalance } from '../lib/wallet';
import { fmt, n } from '../lib/format';

/**
 * One side of a pair: amount input + token select, plus an optional balance
 * chip that doubles as a Max button.
 *
 * `onOverBalance` lets the parent disable its submit button without having to
 * read the balance itself.
 */
export default function AssetField({
  label,
  tokens,
  token,
  onToken,
  exclude,
  amount,
  onAmount,
  readOnly = false,
  account,
  chainId,
  showBalance = false,
  onOverBalance,
}) {
  const [balance, setBalance] = useState(null);

  // Reads off the wallet's current chain, so it's stale until the wallet
  // switches to the one selected in the header.
  useEffect(() => {
    if (!showBalance || !account || !token) return setBalance(null);
    let dead = false;
    readBalance(token.address, account)
      .then((b) => !dead && setBalance(b))
      .catch(() => !dead && setBalance(null));
    return () => {
      dead = true;
    };
  }, [showBalance, account, token, chainId]);

  let over = false;
  if (balance !== null && token && Number(amount) > 0) {
    try {
      over = ethers.parseUnits(amount, token.decimals) > balance;
    } catch {
      over = false;
    }
  }
  useEffect(() => {
    onOverBalance?.(over);
  }, [over, onOverBalance]);

  const list = tokens.filter((t) => t.address !== exclude?.address);

  return (
    <>
      <div className="label-row">
        <label>{label}</label>
        {showBalance && balance !== null && token && (
          <button className="max" onClick={() => onAmount(ethers.formatUnits(balance, token.decimals))}>
            Balance {n(fmt(balance, token.decimals))}
          </button>
        )}
      </div>

      <div className={over ? 'row bad' : 'row'}>
        <input
          className={readOnly ? 'amt out' : 'amt'}
          placeholder="0.0"
          readOnly={readOnly}
          value={amount}
          onChange={readOnly ? undefined : (e) => onAmount(e.target.value.replace(/[^0-9.]/g, ''))}
        />
        <select
          value={token?.address || ''}
          onChange={(e) => onToken(list.find((t) => t.address === e.target.value) || null)}
        >
          <option value="">Token</option>
          {list.map((t) => (
            <option key={t.address} value={t.address}>{t.symbol}</option>
          ))}
        </select>
      </div>
    </>
  );
}
