import { useState } from 'react';
import CreateAuction from '../components/CreateAuction';
import MyAuctions from '../components/MyAuctions';

// Create on the left, the user's auctions on the right. Creating one bumps
// `reload` so the table picks it up without waiting for the next poll.
export default function Auctions({ oct, account, chainId, tokens }) {
  const [reload, setReload] = useState(0);

  return (
    <div className="columns">
      <CreateAuction
        oct={oct}
        account={account}
        chainId={chainId}
        tokens={tokens}
        onCreated={() => setReload((r) => r + 1)}
      />
      <MyAuctions oct={oct} account={account} chainId={chainId} reload={reload} />
    </div>
  );
}
