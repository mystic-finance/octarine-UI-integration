// Octarine API client. See ../../README.md for the endpoint docs.
// No auth needed for any of this.
const BASE = 'https://staging-api.mysticfinance.xyz/octarine';

export function api(base = BASE) {
  async function call(method, path, { query, body } = {}) {
    const url = new URL(base.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, {
      method,
      // Only on writes. A content-type header on a GET is enough to make the
      // browser send a CORS preflight for every read, which doubles the calls.
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => ({}));
    // the API puts the real reason in `message`, status alone isn't enough
    if (!res.ok) throw new Error(json.message || `${path} -> ${res.status}`);
    return json;
  }

  return {
    chains: () => call('GET', '/chains').then((r) => r.data),
    tokens: () => call('GET', '/tokens'),

    // `T+N` settlement window per token, keyed by lowercased address.
    // Chains with no registry entry return {}.
    redemptionTimes: (chainId) => call('GET', '/tokens/redemption-times', { query: { chainId } }),

    // oracle price, doesn't create anything
    estimate: (query) => call('GET', '/price/estimate', { query }).then((r) => r.data),

    // publishes a real RFQ that bidders can see
    createSwap: (body) => call('POST', '/swap', { body }),

    // status + top 3 bids with their txns
    swapStatus: (id) => call('GET', `/swap/${id}`),

    // this wallet's requests, human-scaled, with the best live bid embedded.
    // add open=true for only what's still actionable, or status='filled,expired'.
    myOrders: (address, query) => call('GET', `/orders/${address}`, { query }),

    // instant bids: send bid.txns yourself, then report the hash here
    recordFill: (body) => call('POST', '/fill', { body }),

    // delayed bids: send the approval, then this. no fill to report yet.
    acceptDelayed: (id, bidId) => call('POST', `/swap/${id}/accept-delayed`, { body: { bidId } }),
  };
}

// Bids arrive whenever a bidder gets to it, so poll the same requestId.
// Resolves with [] if nothing lands in the window: that's a normal outcome,
// not an error, and the request stays live either way.
export async function pollForBids(oct, requestId, { attempts = 20, intervalMs = 1500, signal } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return [];
    try {
      const { bids } = await oct.swapStatus(requestId);
      if (bids?.length) return bids;
    } catch {
      // request may not be readable for a beat after creation, keep trying
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return [];
}
