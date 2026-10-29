/* ============================================================================
 * Consumer Voice — Phase 1 Worker proxy (Cloudflare Workers, ES module).
 *
 * WHY A PROXY (not a direct browser -> Baseten call): the Baseten API key
 * must NEVER appear in browser JavaScript, in this repo, or in any public
 * artifact. A public repo + a key in client code = a stolen key. So the
 * browser talks ONLY to this Worker, and ONLY this Worker (server side)
 * holds BASETEN_API_KEY as an encrypted Worker secret. The browser never
 * sees the key, the model id, or the Baseten URL.
 *
 * SINGLE-PURPOSE ENDPOINT (not a generic relay): the client sends ONLY
 * { transcript }. The system prompt, the model id, and the decoding
 * parameters are built HERE, server side. The client cannot ask for a
 * different model, different messages, or arbitrary completions — so the
 * Worker URL alone cannot be reused as a free Baseten proxy.
 *
 * CONTRACT (same as mock-model.js):
 *   POST { transcript: string } -> 200 {
 *     company, issue, demand, amount, category, letterAr, letterFr,
 *     extractionNotes }
 *   - amount: number (MAD) or null. category: one of shop | telecom |
 *     delivery | bank | internet | other. extractionNotes: string[].
 *   - Empty strings / null are honest gaps for unstated facts, never
 *     guesses. The app's verifyCase check turns gaps into user feedback.
 *
 * JSON VALIDATION (Baseten Spark Open does NOT support structured
 * outputs / JSON mode): the model is prompted for JSON-only output, the
 * response is parsed defensively (fences stripped, {...} extracted), and
 * the shape is checked in code. On parse failure the call is RETRIED
 * (initial attempt + up to 3 retries = 4 attempts max). After the last
 * failure the proxy returns 502 with an error class ONLY — unparsed
 * model output is NEVER returned to the client and must never publish.
 *
 * SECRETS: BASETEN_API_KEY comes from env (Worker secret, encrypted).
 * It is sent ONLY in the Authorization header to Baseten. It is never
 * logged, never echoed in a response, and never appears in this file.
 * OPTIONAL: ALLOWED_ORIGIN (comma-separated origins). When unset, any
 * origin is allowed (dev mode); set it before any public launch beyond
 * the hackathon demo so other sites cannot spend this key's credits.
 *
 * DEPLOY (Seg, on his phone — see DEPLOY.md): dashboard -> Workers ->
 * create Worker -> paste this file -> Settings -> Variables -> add
 * secret BASETEN_API_KEY (Encrypt) -> deploy -> copy the Worker URL ->
 * set it as PROXY_URL in live-model.js -> push.
 * ========================================================================== */

const BASETEN_URL = "https://inference.baseten.co/v1/chat/completions";
const MODEL_ID = "meta-models/muse-spark-open-1026";
const MAX_ATTEMPTS = 4; // 1 initial + up to 3 retries on parse failure
const MAX_TRANSCRIPT_CHARS = 4000;
const UPSTREAM_TIMEOUT_MS = 60000;
const CATEGORIES = ["shop", "telecom", "delivery", "bank", "internet", "other"];

/* The system prompt. No real company names, no law article numbers, no
 * quoted provisions anywhere in it — the placeholder lines below are the
 * ONLY legal reference the model is allowed to put in a letter. */
const SYSTEM_PROMPT = [
  "You structure a Moroccan consumer complaint into JSON. The user message",
  "is the consumer's complaint, spoken or written in Moroccan Darija",
  "(possibly mixed with Modern Standard Arabic or French).",
  "",
  "Return ONLY a JSON object, with no markdown fences, no explanation,",
  "and no text outside the JSON. The object must have exactly these keys:",
  '- "company": string. The company or shop name exactly as the consumer',
  '  stated it. If the consumer did not name a company, use "" (empty',
  "  string). NEVER invent a company name.",
  '- "issue": string. A concise description of what happened, in the',
  '  consumer\'s own terms. If unclear, use "".',
  '- "demand": string. What the consumer wants (refund, exchange, repair,',
  '  cancellation, compensation, apology...). If unclear, use "".',
  '- "amount": number or null. The amount of money in Moroccan dirhams',
  "  (MAD) if the consumer stated one, otherwise null. Never guess an amount.",
  '- "category": one of "shop", "telecom", "delivery", "bank", "internet", "other".',
  '- "letterAr": string. A formal complaint letter draft in Modern Standard',
  "  Arabic, addressed to the company's customer service, using ONLY the",
  "  facts above. It must end by asking for a written resolution within a",
  "  reasonable time. It must contain this exact placeholder line instead",
  "  of any legal citation:",
  "  [مرجع قانون حماية المستهلك — قيد التحقق، لا يُدرج أي رقم مادة قبل التحقق من الأحكام أثناء البناء]",
  '- "letterFr": string. The same letter in formal French, with this exact',
  "  placeholder line instead of any legal citation:",
  "  [Référence légale (protection du consommateur) — en cours de vérification ; aucun article ne sera cité avant vérification pendant la construction]",
  '- "extractionNotes": array of strings. Note anything uncertain or',
  "  missing (for example, a company name you could not identify, or a",
  "  demand you could not determine). Empty array if everything was clear.",
  "",
  "Rules: extract ONLY what the consumer stated. Empty strings and null",
  "are honest answers for unstated facts — never fill gaps with guesses.",
  "NEVER cite a law article number or quote a legal provision; the",
  "placeholder lines above are the only legal reference allowed. The",
  "letters are drafts the consumer reviews and sends in their own name.",
].join("\n");

function corsHeaders(request, env) {
  const allowList = (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const allowOrigin =
    allowList.length === 0 ? "*" : allowList.includes(origin) ? origin : allowList[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(request, env, body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}

/* Defensive JSON parse: strip code fences, then fall back to the first
 * {...} span. Returns the parsed value or null on failure. */
function parseModelJson(content) {
  if (typeof content !== "string") return null;
  let text = content.trim();
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    /* Fall through to the {...} extraction. */
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

/* Shape check. The 5 string fields gate success (a missing/wrong-typed
 * one = parse failure -> retry). amount/category/extractionNotes get
 * safe normalization instead of a retry: a non-numeric amount becomes
 * null (honest gap), an unknown category becomes "other", bad notes
 * are dropped. Empty strings are VALID (honest gaps for the app check). */
function validateShape(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const str = (v) => (typeof v === "string" ? v : null);
  const company = str(obj.company);
  const issue = str(obj.issue);
  const demand = str(obj.demand);
  const letterAr = str(obj.letterAr);
  const letterFr = str(obj.letterFr);
  if (
    company === null ||
    issue === null ||
    demand === null ||
    letterAr === null ||
    letterFr === null
  ) {
    return null;
  }
  let amount = null;
  if (typeof obj.amount === "number" && Number.isFinite(obj.amount)) {
    amount = obj.amount;
  } else if (typeof obj.amount === "string" && /^\d+(\.\d+)?$/.test(obj.amount.trim())) {
    amount = Number(obj.amount.trim());
  } else {
    amount = null;
  }
  const category = CATEGORIES.includes(obj.category) ? obj.category : "other";
  const extractionNotes = Array.isArray(obj.extractionNotes)
    ? obj.extractionNotes.filter((n) => typeof n === "string")
    : [];
  return { company, issue, demand, amount, category, letterAr, letterFr, extractionNotes };
}

async function callBaseten(env, transcript) {
  const res = await fetch(BASETEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.BASETEN_API_KEY,
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      temperature: 0.2,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) return { upstreamError: true };
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { upstreamError: true };
  }
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
  if (typeof content !== "string") return { upstreamError: true };
  return { content };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return jsonResponse(request, env, { error: "method_not_allowed" }, 405);
    }
    if (!env.BASETEN_API_KEY) {
      /* Server misconfiguration. No key material is ever in this body. */
      return jsonResponse(request, env, { error: "server_not_configured" }, 500);
    }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse(request, env, { error: "invalid_json_body" }, 400);
    }
    const transcript =
      body && typeof body.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript || transcript.length > MAX_TRANSCRIPT_CHARS) {
      return jsonResponse(request, env, { error: "invalid_transcript" }, 400);
    }

    /* Parse-failure retries only. Upstream errors (non-2xx, bad upstream
     * JSON, timeout) return 502 immediately — the browser falls back to
     * the MOCK layer and the user is never left hanging on retries. */
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let result;
      try {
        result = await callBaseten(env, transcript);
      } catch (e) {
        return jsonResponse(request, env, { error: "model_upstream_error" }, 502);
      }
      if (result.upstreamError) {
        return jsonResponse(request, env, { error: "model_upstream_error" }, 502);
      }
      const parsed = parseModelJson(result.content);
      const shaped = parsed === null ? null : validateShape(parsed);
      if (shaped !== null) {
        return jsonResponse(request, env, shaped, 200);
      }
      /* Parse failure: retry until MAX_ATTEMPTS, then fail closed. */
      if (attempt === MAX_ATTEMPTS) {
        return jsonResponse(request, env, { error: "model_parse_failed" }, 502);
      }
    }
    /* Unreachable (loop always returns), kept so no path falls through. */
    return jsonResponse(request, env, { error: "model_parse_failed" }, 502);
  },
};
