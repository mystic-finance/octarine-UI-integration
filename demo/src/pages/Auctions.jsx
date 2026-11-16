import { useState } from 'react';
import CreateAuction from '../components/CreateAuction';
import MyAuctions from '../components/MyAuctions';

// Create on the left, the user's auctions on the right. Creating one bumps
// `reload` so the table picks it up without waiting for the next poll.
//
// `rfq` is the chain's OctarineRFQ (from GET /chains): what the request is
// signed for and what a cancel targets. `sellable` / `stables` / `schedules`
// come from the RFQ's on-chain schedules (see App.jsx).
export default function Auctions({ oct, account, chainId, rfq, tokens, sellable, stables, schedules }) {
  const [reload, setReload] = useState(0);

  return (
    <div className="columns">
      <CreateAuction
        oct={oct}
        account={account}
        chainId={chainId}
        rfq={rfq}
        tokens={tokens}
        sellable={sellable}
        stables={stables}
        schedules={schedules}
        onCreated={() => setReload((r) => r + 1)}
      />
      <MyAuctions oct={oct} account={account} chainId={chainId} rfq={rfq} reload={reload} />
    </div>
  );
}
