/* ============================================================================
 * LIVE MODEL CLIENT — Phase 1 (browser side).
 *
 * Calls the Cloudflare Worker proxy (worker-proxy.js), NEVER Baseten
 * directly. The Baseten API key lives ONLY as a server-side Worker secret
 * (BASETEN_API_KEY), so browser code must never see it, send it, or log
 * it. This file contains no key, no Authorization header, and no Baseten
 * URL — only the proxy URL, which is public by nature (the Worker URL).
 *
 * CONTRACT (same as mock-model.js):
 *   structureComplaintLive({ transcript }) -> Promise<{
 *     company, issue, demand, amount, category, letterAr, letterFr,
 *     extractionNotes }>
 *   - amount is a STRING here ("" when the proxy returned null), because
 *     app.js writes it straight into a text input. category is always one
 *     of shop | telecom | delivery | bank | internet | other.
 *   - Empty strings are honest gaps, not guesses — the app's verifyCase
 *     check turns them into user feedback, exactly like the MOCK layer.
 *   - On ANY proxy failure (not configured, network error, timeout,
 *     non-2xx, bad payload) this function THROWS and app.js falls back to
 *     the MOCK layer with a visible trace note. It never returns fake
 *     data and never invents a case.
 *
 * CONFIG: set LIVE_CONFIG.PROXY_URL to the deployed Worker URL (see
 * DEPLOY.md). While it is "" the app stays on the MOCK layer and the
 * banner says so honestly — nothing silently pretends to be live.
 * ========================================================================== */
(function (global) {
  "use strict";

  var LIVE_CONFIG = {
    /* Deployed Worker (2026-10-29, by Muse per Seg's order).
     * Secret BASETEN_API_KEY still to be set by Seg in the dashboard;
     * until then the proxy answers 500 server_not_configured and the
     * app falls back to MOCK honestly. */
    PROXY_URL: "https://consumer-voice-proxy.numaa.workers.dev",
  };

  var CATEGORIES = ["shop", "telecom", "delivery", "bank", "internet", "other"];
  var TIMEOUT_MS = 60000;

  function asString(v) {
    return typeof v === "string" ? v : "";
  }

  /* Normalize a proxy payload to the exact contract shape. The proxy
   * already validates, but the browser normalizes defensively too so a
   * malformed payload can never break the UI or publish a bad case. */
  function normalizePayload(json) {
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("proxy_bad_payload");
    }
    var amount = "";
    if (typeof json.amount === "number" && isFinite(json.amount)) {
      amount = String(json.amount);
    }
    var category =
      CATEGORIES.indexOf(json.category) !== -1 ? json.category : "other";
    var notes = Array.isArray(json.extractionNotes)
      ? json.extractionNotes.filter(function (n) {
          return typeof n === "string";
        })
      : [];
    return {
      company: asString(json.company),
      issue: asString(json.issue),
      demand: asString(json.demand),
      amount: amount,
      category: category,
      letterAr: asString(json.letterAr),
      letterFr: asString(json.letterFr),
      extractionNotes: notes,
    };
  }

  async function structureComplaintLive(options) {
    var transcript = (options && options.transcript) || "";
    if (!LIVE_CONFIG.PROXY_URL) {
      throw new Error("proxy_not_configured");
    }
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, TIMEOUT_MS);
    try {
      var res = await fetch(LIVE_CONFIG.PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: transcript }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error("proxy_http_" + res.status);
      }
      var json = await res.json();
      return normalizePayload(json);
    } finally {
      clearTimeout(timer);
    }
  }

  global.LIVE_CONFIG = LIVE_CONFIG;
  global.structureComplaintLive = structureComplaintLive;
  /* Node/CommonJS export (tests only; browsers ignore this branch). */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      LIVE_CONFIG: LIVE_CONFIG,
      structureComplaintLive: structureComplaintLive,
      normalizePayload: normalizePayload,
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
