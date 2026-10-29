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
 *
 * ARMY MODE (Phase 2, added 2026-10-29 — adapted from the Grok "army"
 * spec, NOT literal LangGraph/LiteLLM):
 *   POST /army { transcript } -> 200 { mode: "army", extraction,
 *   case_summary, company_info, arabic_letter, french_letter,
 *   public_post, needs_approval: true, human_decision: null, trace,
 *   metadata }. The Supervisor is deterministic CODE (not a model call):
 *   it runs 5 specialist Spark Open calls in sequence — Listener,
 *   Organizer, Researcher, Writer, Pressure — each JSON-validated with
 *   the same fail-closed retry rules as the single-call path, and
 *   assembles the shared state. The pipeline STOPS at the Human Approval
 *   Gate: the response contains drafts ONLY. This Worker has NO
 *   publish, send, or contact code path at all — publishing happens
 *   only in the browser, after explicit human approval, and the app's
 *   publish action re-runs its own verification check. Meta-only
 *   runtime: every agent call uses MODEL_ID (Muse Spark Open via
 *   Baseten); no other provider is ever called. The original POST /
 *   single-call path is UNCHANGED — /army is strictly additive.
 * ========================================================================== */

const BASETEN_URL = "https://inference.baseten.co/v1/chat/completions";
const MODEL_ID = "meta-models/muse-spark-open-1026";
const MAX_ATTEMPTS = 4; // 1 initial + up to 3 retries on parse failure
/* Token budgets: Spark Open is a reasoning model — a writer call was
 * observed spending ~1841 tokens on internal reasoning before writing
 * anything (finish_reason "length" at 2000 tokens, letters truncated
 * mid-JSON, parse failure x4). Budgets must cover reasoning + answer:
 * reasoning alone can approach ~1900 tokens, so EVERY agent gets 4000
 * (short answers still fit with margin); the two-letter Writer needs
 * 8000; the single-call path (extraction + two letters in one call)
 * gets 4000. */
const DEFAULT_MAX_TOKENS = 4000;
const SINGLE_MAX_TOKENS = 4000;
const WRITER_MAX_TOKENS = 8000;
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

async function callBaseten(env, systemPrompt, userContent, maxTokens) {
  let res;
  try {
    res = await fetch(BASETEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.BASETEN_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    /* Network/timeout. Status 0 = no HTTP response was received. */
    return { upstreamError: true, upstreamStatus: 0 };
  }
  if (!res.ok) return { upstreamError: true, upstreamStatus: res.status };
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { upstreamError: true, upstreamStatus: -1 };
  }
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
  /* Null/non-string content is a MALFORMED model response, not a
   * transport failure: callers retry it like a parse failure instead
   * of failing immediately (Baseten has returned content: null
   * intermittently before). */
  if (typeof content !== "string") return { nullContent: true };
  return { content };
}

/* ==========================================================================
 * ARMY MODE — 5 specialist agents + deterministic supervisor + gate.
 * Every agent is ONE Muse Spark Open call (MODEL_ID, Meta-only) with a
 * specialist system prompt, JSON-only output, and the same fail-closed
 * validation/retry rules as the single-call path. The supervisor is
 * CODE: it runs the agents in sequence and assembles the shared state.
 * No agent invents facts; no agent cites a law article number or quotes
 * a provision — the Writer's placeholder lines are the only legal
 * reference allowed anywhere in army output.
 * ========================================================================== */

const ARMY_LAW_AR = "[مرجع قانون حماية المستهلك — قيد التحقق، لا يُدرج أي رقم مادة قبل التحقق من الأحكام أثناء البناء]";
const ARMY_LAW_FR = "[Référence légale (protection du consommateur) — en cours de vérification ; aucun article ne sera cité avant vérification pendant la construction]";

const LISTENER_PROMPT = [
  "You are the Darija Listener of a Moroccan consumer-complaint system.",
  "The user message is a complaint in Moroccan Darija (possibly mixed",
  "with Modern Standard Arabic or French). Understand it precisely,",
  "including emotional context, but extract ONLY stated facts.",
  "",
  "Return ONLY a JSON object, no markdown fences, no text outside it,",
  "with exactly these keys:",
  '- "company": string, the company/shop name exactly as stated, "" if unstated. NEVER invent one.',
  '- "issue": string, what happened, in the consumer\'s own terms, "" if unclear.',
  '- "demand": string, what the consumer wants (refund, exchange, repair, cancellation, compensation, apology...), "" if unclear.',
  '- "amount": number or null, money in MAD if stated, otherwise null. Never guess.',
  '- "category": one of "shop", "telecom", "delivery", "bank", "internet", "other".',
  '- "facts": array of strings, each a single stated fact (no inference, no new facts).',
  '- "extractionNotes": array of strings, anything uncertain or missing. Empty array if all clear.',
].join("\n");

const ORGANIZER_PROMPT = [
  "You are the Case Organizer of a Moroccan consumer-complaint system.",
  "The user message is the Listener agent's JSON extraction. Reorganize",
  "it into a professional case template WITHOUT adding any new fact.",
  "",
  "Return ONLY a JSON object, no markdown fences, no text outside it,",
  "with exactly these keys:",
  '- "title": string, a short neutral case title.',
  '- "parties": object with "complainant" (string; "المشتكي" unless the consumer named themselves) and "company" (string, from the extraction).',
  '- "factsSummary": string, a concise neutral summary of the facts.',
  '- "timeline": array of strings, events in order as stated (empty array if no dates/steps were stated — never invent a timeline).',
  '- "evidence": array of strings, evidence the consumer said they have (receipts, photos, messages...); empty array if none stated.',
  '- "demand": string, the requested resolution, from the extraction.',
].join("\n");

const RESEARCHER_PROMPT = [
  "You are the Company Researcher of a Moroccan consumer-complaint system.",
  "The user message is the Organizer agent's case JSON. Give general,",
  "useful context ONLY: the type of business/activity implied by the",
  "case, and the GENERAL areas of Moroccan consumer-protection law that",
  "could be relevant (area names only, e.g. \"حماية المستهلك\").",
  "",
  "STRICT BANS: NEVER cite a law article number. NEVER quote a legal",
  "provision. NEVER invent company facts, addresses, or prior cases.",
  "If you do not know something, say so plainly in notes.",
  "",
  "Return ONLY a JSON object, no markdown fences, no text outside it,",
  "with exactly these keys:",
  '- "activity": string, the business/activity type implied by the case.',
  '- "lawAreas": array of strings, general legal areas only (no numbers, no quotes).',
  '- "notes": string, plain-language notes, including an explicit statement when nothing specific was found.',
  '- "foundSomething": boolean, true only if you gave a genuinely useful specific context; false otherwise.',
].join("\n");

const WRITER_PROMPT = [
  "You are the Legal & Letter Writer of a Moroccan consumer-complaint system.",
  "The user message is JSON with case_summary and company_info. Write TWO",
  "separate formal complaint-letter drafts, using ONLY the facts in the",
  "case (never add facts, amounts, dates, or claims). Both letters must",
  "be polite and firm, addressed to the company's customer service, and",
  "end by asking for a written resolution within a reasonable time.",
  "The letters are drafts the consumer reviews and sends in their own name.",
  "",
  "STRICT BANS: NEVER cite a law article number. NEVER quote a legal",
  "provision. Each letter MUST contain its exact placeholder line below",
  "as its only legal reference.",
  "",
  "Return ONLY a JSON object, no markdown fences, no text outside it,",
  "with exactly these keys:",
  '- "letterAr": string, the formal letter in Modern Standard Arabic, containing this exact line:',
  "  " + ARMY_LAW_AR,
  '- "letterFr": string, the same letter in formal French, containing this exact line:',
  "  " + ARMY_LAW_FR,
].join("\n");

const PRESSURE_PROMPT = [
  "You are the Public Pressure Agent of a Moroccan consumer-complaint system.",
  "The user message is JSON with case_summary and extraction. Draft ONE",
  "public-board post mixing Darija and Modern Standard Arabic that puts",
  "positive public pressure on the company. Rules: present the complaint",
  "as a USER ALLEGATION, never as a proven verdict; use ONLY stated",
  "facts; NO personal data (no phone numbers, emails, addresses, full",
  "names); NO insults, threats, or defamatory wording; end the post with",
  "the line: — ادعاء مستخدم، بانتظار رد الشركة.",
  "",
  "Return ONLY a JSON object, no markdown fences, no text outside it,",
  'with exactly one key: "public_post": string, the post draft.',
].join("\n");

function armyStrArray(v) {
  return Array.isArray(v) ? v.filter((n) => typeof n === "string") : [];
}

function validateListener(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const str = (v) => (typeof v === "string" ? v : null);
  const company = str(obj.company);
  const issue = str(obj.issue);
  const demand = str(obj.demand);
  if (company === null || issue === null || demand === null) return null;
  let amount = null;
  if (typeof obj.amount === "number" && Number.isFinite(obj.amount)) amount = obj.amount;
  else if (typeof obj.amount === "string" && /^\d+(\.\d+)?$/.test(obj.amount.trim())) amount = Number(obj.amount.trim());
  return {
    company, issue, demand, amount,
    category: CATEGORIES.includes(obj.category) ? obj.category : "other",
    facts: armyStrArray(obj.facts),
    extractionNotes: armyStrArray(obj.extractionNotes),
  };
}

function validateOrganizer(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const str = (v) => (typeof v === "string" ? v : null);
  const title = str(obj.title);
  const factsSummary = str(obj.factsSummary);
  const demand = str(obj.demand);
  if (title === null || factsSummary === null || demand === null) return null;
  const parties = obj.parties && typeof obj.parties === "object" && !Array.isArray(obj.parties)
    ? { complainant: str(obj.parties.complainant) || "المشتكي", company: str(obj.parties.company) || "" }
    : { complainant: "المشتكي", company: "" };
  return {
    title, parties, factsSummary, demand,
    timeline: armyStrArray(obj.timeline),
    evidence: armyStrArray(obj.evidence),
  };
}

function validateResearcher(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const str = (v) => (typeof v === "string" ? v : null);
  const activity = str(obj.activity);
  const notes = str(obj.notes);
  if (activity === null || notes === null) return null;
  return {
    activity, notes,
    lawAreas: armyStrArray(obj.lawAreas),
    foundSomething: obj.foundSomething === true,
  };
}

/* Writer gate: placeholders REQUIRED, invented citations FORBIDDEN.
 * A letter missing its placeholder line, or containing "article + digit"
 * style citations, fails validation -> retry -> fail closed. */
function validateWriter(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const str = (v) => (typeof v === "string" ? v : null);
  const letterAr = str(obj.letterAr);
  const letterFr = str(obj.letterFr);
  if (letterAr === null || letterFr === null) return null;
  if (!letterAr.includes("قيد التحقق") || !letterFr.includes("en cours de vérification")) return null;
  const citationRe = /(المادة\s*\d|article\s+\d+)/i;
  if (citationRe.test(letterAr) || citationRe.test(letterFr)) return null;
  return { letterAr, letterFr };
}

function validatePressure(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (typeof obj.public_post !== "string" || !obj.public_post.trim()) return null;
  return { public_post: obj.public_post };
}

/* One agent call with the shared retry policy: parse failures AND
 * null-content responses retry (up to MAX_ATTEMPTS); transport/upstream
 * errors (with their HTTP status, when known) return immediately.
 * parseDetail tells the client WHY validation failed without ever
 * returning raw model output: "null" | "empty" | "unparseable" |
 * "shape". */
async function callAgent(env, systemPrompt, userContent, validate, maxTokens) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await callBaseten(env, systemPrompt, userContent, maxTokens || DEFAULT_MAX_TOKENS);
    } catch (e) {
      return { upstreamError: true, upstreamStatus: 0 };
    }
    if (result.upstreamError) {
      return { upstreamError: true, upstreamStatus: result.upstreamStatus };
    }
    let shaped = null;
    let detail = "null";
    if (!result.nullContent) {
      const text = typeof result.content === "string" ? result.content.trim() : "";
      if (!text) {
        detail = "empty";
      } else {
        const parsed = parseModelJson(result.content);
        if (parsed === null) {
          detail = "unparseable";
        } else {
          shaped = validate(parsed);
          detail = shaped === null ? "shape" : "ok";
        }
      }
    }
    if (shaped !== null) return { ok: true, value: shaped };
    if (attempt === MAX_ATTEMPTS) return { parseFailed: true, parseDetail: detail };
  }
  return { parseFailed: true, parseDetail: "unknown" };
}

/* Supervisor (code, not a model call): runs the 5 agents in order and
 * assembles the shared state. ANY agent failure fails the whole army
 * run closed (502 + error class) — no partial state is ever returned,
 * so the client can fall back to the single-call path honestly. */
async function handleArmy(request, env, transcript) {
  const trace = [];
  const runAgent = async (agent, systemPrompt, userContent, validate, maxTokens) => {
    const started = Date.now();
    const r = await callAgent(env, systemPrompt, userContent, validate, maxTokens);
    if (r.upstreamError) {
      return { error: "model_upstream_error", agent, upstreamStatus: r.upstreamStatus };
    }
    if (r.parseFailed) return { error: "model_parse_failed", agent, parseDetail: r.parseDetail };
    trace.push({ agent, status: "ok", ms: Date.now() - started });
    return { value: r.value };
  };
  /* Fail-closed body: error class + agent name (+ upstream HTTP status
   * when the failure was upstream, + parse detail when validation
   * failed — so the client can tell a 429/5xx from a truncation from
   * a shape rejection). No model output, no key, no body. */
  const fail = (r) => {
    const body = { error: r.error, agent: r.agent };
    if (r.upstreamStatus !== undefined) body.upstreamStatus = r.upstreamStatus;
    if (r.parseDetail !== undefined) body.parseDetail = r.parseDetail;
    return jsonResponse(request, env, body, 502);
  };

  const listener = await runAgent("listener", LISTENER_PROMPT, transcript, validateListener);
  if (listener.error) {
    return fail(listener);
  }
  const organizer = await runAgent("organizer", ORGANIZER_PROMPT, JSON.stringify(listener.value), validateOrganizer);
  if (organizer.error) {
    return fail(organizer);
  }
  const researcher = await runAgent("researcher", RESEARCHER_PROMPT, JSON.stringify(organizer.value), validateResearcher);
  if (researcher.error) {
    return fail(researcher);
  }
  const writer = await runAgent(
    "writer", WRITER_PROMPT,
    JSON.stringify({ case_summary: organizer.value, company_info: researcher.value }),
    validateWriter, WRITER_MAX_TOKENS
  );
  if (writer.error) {
    return fail(writer);
  }
  const pressure = await runAgent(
    "pressure", PRESSURE_PROMPT,
    JSON.stringify({ case_summary: organizer.value, extraction: listener.value }),
    validatePressure
  );
  if (pressure.error) {
    return fail(pressure);
  }

  /* THE GATE: the pipeline stops here. human_decision is null until a
   * human decides in the browser. This Worker cannot publish, send, or
   * contact anyone — no such code path exists — so nothing leaves this
   * response as an action, only as drafts for human review. */
  trace.push({
    agent: "approval_gate",
    status: "waiting",
    blocked: ["publish", "send_letter", "contact_company"],
  });
  return jsonResponse(request, env, {
    mode: "army",
    original_complaint: transcript,
    extraction: listener.value,
    case_summary: organizer.value,
    company_info: researcher.value,
    arabic_letter: writer.value.letterAr,
    french_letter: writer.value.letterFr,
    public_post: pressure.value.public_post,
    current_step: "awaiting_approval",
    human_decision: null,
    needs_approval: true,
    trace,
    metadata: {
      model: MODEL_ID,
      agents: ["listener", "organizer", "researcher", "writer", "pressure"],
      source: "army",
    },
  }, 200);
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

    /* ARMY ROUTE (additive): POST /army runs the 5-agent pipeline.
     * Every other POST keeps the original single-call behavior exactly. */
    let pathname = "";
    try {
      pathname = new URL(request.url).pathname;
    } catch (e) {
      pathname = "";
    }
    if (pathname === "/army") {
      return handleArmy(request, env, transcript);
    }

    /* Parse-failure retries only. Upstream errors (non-2xx, bad upstream
     * JSON, timeout) return 502 immediately — the browser falls back to
     * the MOCK layer and the user is never left hanging on retries. */
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let result;
      try {
        result = await callBaseten(env, SYSTEM_PROMPT, transcript, SINGLE_MAX_TOKENS);
      } catch (e) {
        return jsonResponse(request, env, { error: "model_upstream_error" }, 502);
      }
      if (result.upstreamError) {
        const errBody = { error: "model_upstream_error" };
        if (result.upstreamStatus !== undefined) errBody.upstreamStatus = result.upstreamStatus;
        return jsonResponse(request, env, errBody, 502);
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
