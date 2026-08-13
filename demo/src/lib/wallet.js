import { ethers } from 'ethers';

export const APPROVE_ABI = ['function approve(address,uint256)'];
export const ALLOWANCE_ABI = ['function allowance(address,address) view returns (uint256)'];
export const BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

export async function connectWallet() {
  if (!window.ethereum) throw new Error('No wallet found. Install MetaMask.');
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();
  return {
    account: await signer.getAddress(),
    chainId: Number((await provider.getNetwork()).chainId),
  };
}

// Bid calldata is built for one chain. The wallet won't always be on it, so
// switch first, then check again before we hand back a signer.
export async function signerOn(chainId) {
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

// Throws if the wallet is on a different chain than the token: balanceOf
// against an address with no contract on it doesn't fail cleanly, it comes
// back as empty data and ethers raises BAD_DATA.
export async function readBalance(tokenAddress, owner, expectedChainId) {
  if (!window.ethereum) return null;
  const provider = new ethers.BrowserProvider(window.ethereum);

  const live = Number((await provider.getNetwork()).chainId);
  if (expectedChainId != null && live !== expectedChainId) {
    throw new Error(`Wallet is on chain ${live}, expected ${expectedChainId}`);
  }
  return new ethers.Contract(tokenAddress, BALANCE_ABI, provider).balanceOf(owner);
}

// Sends bid.txns in order, returns the hash of the last one.
// Empty string if we skipped everything, which is fine for a delayed bid
// that's already approved but not for an instant fill.
export async function executeBid(bid, chainId, owner, onStep = () => {}) {
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
