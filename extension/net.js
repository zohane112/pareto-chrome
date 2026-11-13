// One way to call a JSON HTTP API: a per-request timeout, retries with backoff for the
// failures worth retrying, and a typed `code` for everything else.
//
// The scorer (Jev) and the hosted AI provider both go through here, so a 401 means the same
// thing and reads the same way whichever one it came from. The codes are the ones the search
// box already explains in plain English:
//   bad-key | no-funds | busy | timeout | offline | <the caller's fallback code>
//
// This file knows nothing about Jev or about AI. Callers pass `fail`, which builds their own
// error class (ScoreError, AiError), so the error that comes out is theirs.

(() => {
  const CtrlF = (globalThis.CtrlF ??= {});

  const RETRIES = 3;          // for 408, 429, and 5xx (529 means the service is overloaded)
  const FIRST_WAIT_MS = 500;  // doubles each retry, like TypeSafe's own SDKs
  const MAX_WAIT_MS = 5000;

  // How long to wait before the next try: the service's own retry-after when it sends one,
  // otherwise exponential backoff with jitter.
  function waitMs(res, attempt, firstWait, maxWait) {
    const ms = Number(res.headers.get("retry-after-ms"));
    const s = Number(res.headers.get("retry-after"));
    if (ms > 0) return Math.min(ms, maxWait);
    if (s > 0) return Math.min(s * 1000, maxWait);
    const backoff = Math.min(firstWait * 2 ** attempt, maxWait);
    return backoff * (1 - 0.25 * Math.random());
  }

  // A refusal that talks about money is out-of-funds whatever status it arrived with.
  const FUNDS = /fund|credit|balance|billing|payment|quota|insufficient_quota/i;

  // POST JSON, get JSON back. Throws whatever `fail(code, message, extra)` returns.
  //
  //   url        where to post
  //   headers    added to Content-Type: application/json
  //   body       an object, sent as JSON
  //   timeoutMs  per request, not per call: each retry gets the full timeout
  //   service    names the service in messages. Sentence-start form, e.g. "Jev", "the AI".
  //   fallback   the code for an HTTP error none of the shared rules claim
  //   fail       (code, message, extra) => Error
  //   raw        true returns the Response itself, unread, for a streamed reply. Its body
  //              is still under the same timeout.
  async function postJson(url, { headers = {}, body, timeoutMs, service, fallback, fail, raw = false,
                                 retries = RETRIES, firstWaitMs = FIRST_WAIT_MS, maxWaitMs = MAX_WAIT_MS }) {
    const Service = service.charAt(0).toUpperCase() + service.slice(1);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err.name === "TimeoutError") throw fail("timeout", `${Service} didn't answer within ${timeoutMs / 1000} seconds.`);
        throw fail("offline", `Couldn't reach ${service}: ${err.message}`);
      }
      if (res.ok) return raw ? res : res.json();

      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, waitMs(res, attempt, firstWaitMs, maxWaitMs)));
        continue;
      }
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      // Out of funds: HTTP 402, or a refusal that says so.
      if (res.status === 402 || (res.status >= 400 && res.status < 500 && res.status !== 429 && FUNDS.test(detail))) {
        throw fail("no-funds", `${Service} returned HTTP ${res.status}: ${detail}`, { status: res.status });
      }
      if (res.status === 401 || res.status === 403) throw fail("bad-key", `${Service} didn't accept the key.`, { status: res.status });
      if (res.status === 429 || res.status === 529) {
        throw fail("busy", `${Service} was still busy after ${retries} retries.`, { status: res.status });
      }
      throw fail(fallback, `${Service} returned HTTP ${res.status}: ${detail}`, { status: res.status });
    }
  }

  CtrlF.postJson = postJson;
})();
