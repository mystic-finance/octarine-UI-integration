// Octarine API client. See ../../README.md for the endpoint docs.
// No API key needed for any of this: the user's request signature is what
// authorises a trade, not a credential.
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
    if (!res.ok) {
      const err = new Error(json.message || `${path} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    // [{ chainId, name, rfq, supported }]. `rfq` is the OctarineRFQ contract:
    // the EIP-712 verifyingContract and the approval spender.
    chains: () => call('GET', '/chains').then((r) => r.data),

    // [{ chainId, address, symbol, name, decimals, logoURI, isStable }].
    // Which of these the RFQ will buy, and their redemption schedules, is read
    // from the contract itself: see readSchedules in lib/wallet.js.
    tokens: () => call('GET', '/tokens'),

    // oracle price, doesn't create anything
    estimate: (query) => call('GET', '/price/estimate', { query }).then((r) => r.data),

    // Creates the request and returns the terms to sign:
    //   { requestId, typedData, requestHash, signatureRequired, feeBps, feeRecipient, request, bids }
    // Optional body fields: minReceivedAmount (base units) and takerMaxBpsPerDay
    // (human bps/day). Leave them out and the server derives both from
    // slippageTolerance and the asset's horizon.
    createSwap: (body) => call('POST', '/swap', { body }),

    // The user's EIP-712 signature over typedData. Until this lands the request
    // can collect bids but nothing can settle.
    submitRequestSignature: (requestId, signature) =>
      call('POST', '/swap/signature', { body: { requestId, signature } }),

    // status + top bids, each with the txns that fill it. Ranked lowest rate first.
    swapStatus: (id) => call('GET', `/swap/${id}`),

    // this wallet's requests, human-scaled, with the best live bid embedded.
    // add open=true for only what's still actionable, or status='filled,expired'.
    // Rows are a summary: the signed terms (salt, rfqOrder, signatureRequired,
    // requestHash) are only on GET /request/:id below.
    myOrders: (address, query) => call('GET', `/orders/${address}`, { query }),

    // One request in full: status plus the signed terms, never the signature.
    //   { requestId, status, expiryTime, salt, requestHash, signatureRequired,
    //     rfqContract, rfqOrder, metadata: { rfqOrder, … }, … }
    // A request from before the OctarineRFQ switch has no requestHash.
    request: (id) => call('GET', `/request/${id}`),

    // Report an instant fill. The server re-reads RFQOrderFilled from the
    // receipt, so the amounts sent here are a cross-check, not the record.
    recordFill: (body) => call('POST', '/fill', { body }),

    // Closes the request off-chain and returns { cancelTx: { to, data } }, the
    // cancelSalt(user, salt) call that voids the signature on-chain. Origin
    // allowlisted; when it refuses, build cancelSalt yourself (cancelRequest
    // in lib/wallet.js does).
    cancelRequest: (id) => call('DELETE', `/request/${id}`),
    // Locks in the delayed bid the user picked. Octarine then fills it with
    // the stored request signature once the bidder funds.
    acceptDelayed: (id, bidId) => call('POST', `/swap/${id}/accept-delayed`, { body: { bidId } }),
  };
}

// Bids arrive whenever a solver gets to it, so poll the same requestId.
// Resolves with [] if nothing lands in the window: that's a normal outcome,
// not an error, and the request stays live either way.
export async function pollForBids(oct, requestId, { attempts = 60, intervalMs = 1500, signal } = {}) {
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
