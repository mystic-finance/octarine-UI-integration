// Octarine API client. Every method maps to an endpoint in ../../README.md.
// No credentials needed — the whole user flow is open.
const BASE = 'https://api.mysticfinance.xyz/octarine';

export function api(base = BASE) {
  const call = async (method, path, { query, body } = {}) => {
    const url = new URL(base.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `${path} → ${res.status}`);
    return json;
  };

  return {
    chains: () => call('GET', '/chains').then((r) => r.data),
    tokens: () => call('GET', '/tokens'),

    // Oracle estimate. Free, creates nothing.
    estimate: (query) => call('GET', '/price/estimate', { query }).then((r) => r.data),

    // Creates a real RFQ that market makers see — debounce it.
    createSwap: (body) => call('POST', '/swap', { body }),

    // Status + up to 3 bids, each with the `txns` your wallet sends.
    swapStatus: (id) => call('GET', `/swap/${id}`),

    // "My auctions": every request this wallet placed, best live bid embedded.
    myAuctions: (address, query) => call('GET', `/orders/${address}`, { query }),

    // Instant bids: send bid.txns yourself, then record the hash here.
    recordFill: (body) => call('POST', '/fill', { body }),

    // Delayed bids: this call IS the accept. No wallet tx, no recordFill.
    acceptDelayed: (id, bidId) => call('POST', `/swap/${id}/accept-delayed`, { body: { bidId } }),
  };
}
