# ARMY.md — the Consumer Voice agent army (Phase 2, Worker-native)

## What it is

The "Morocco Complaints Army" from the project spec, adapted to the
hackathon's hard rules. One complaint goes through 5 specialist agents
in sequence, supervised by deterministic code, and STOPS at a mandatory
human approval gate. Nothing publishes, sends, or contacts anyone
without explicit human approval.

## Why adapted (not literal LangGraph + LiteLLM)

The spec was written without the hackathon's runtime rule. Applied
literally it would break the entry, so three things were changed —
openly, not silently:

1. **LangGraph (Python) → Worker-native pipeline.** LangGraph cannot
   run on Cloudflare Workers, the project's $0 host. A Python service
   would be a second system with its own hosting, secrets, and failure
   modes, for no demo gain. The pipeline below runs in the same Worker
   as the proven single-call path.
2. **LiteLLM multi-provider rotation → Meta-only.** The hackathon rule
   is strict: every model called at runtime must be a Meta model.
   Rotating across OpenAI / Anthropic / Google / Grok would fail Stage
   1, even as a fallback. Every agent call below uses exactly one
   model: `meta-models/muse-spark-open-1026` (Muse Spark Open) via
   Baseten. The spec itself allows starting with one key.
3. **Noyce bot integration → OUT.** The live Noyce bot is never touched
   for the hackathon entry (separate product, separate repo), and the
   entry is a demo, not a long-term service. No bot link is built.

## The agents (all Meta Spark Open, all JSON-validated)

```
transcript ──► Supervisor (code, not a model call)
  1. Darija Listener    → extraction: company, issue, demand, amount,
                           category, facts[], extractionNotes
  2. Case Organizer     → case_summary: title, parties, factsSummary,
                           timeline[], evidence[], demand
  3. Company Researcher → company_info: activity, lawAreas[] (general
                           area names ONLY), notes, foundSomething
  4. Letter Writer      → letterAr + letterFr (formal drafts)
  5. Public Pressure    → public_post draft (Darija + formal mix)
  ⛔ Human Approval Gate → STOPS. human_decision = null until a human
                           decides in the browser.
```

- **Supervisor = code.** It routes state between agents in order. It
  is not a 6th model call: routing decisions here are deterministic,
  and an extra call would add latency and cost for nothing.
- **Shared state** (per the spec): `original_complaint`, `extraction`,
  `case_summary`, `company_info`, `arabic_letter`, `french_letter`,
  `public_post`, `current_step`, `human_decision`, `needs_approval`,
  `trace` (per-agent results), `metadata`.
- **Validation, same as Phase 1:** each agent's JSON is parsed
  defensively (fences stripped, `{...}` extracted), shape-checked in
  code, retried max 3 times on parse failure. A null/non-string model
  content is retried like a parse failure (Baseten has returned
  `content: null` intermittently before). Any agent failing
  (upstream error or parse failure after retries) fails the whole run
  closed with a 502 error class + agent name (+ upstream HTTP status
  when the failure was upstream, so a 429/5xx is distinguishable from
  a transport failure) — no partial state is ever returned,
  so the browser can fall back to the single-call path honestly.
- **Law rule (structural, not just prompted):** the Researcher may give
  general legal AREA names only — never an article number, never a
  quoted provision, never an invented company fact. The Writer's
  letters MUST contain the exact placeholder lines (`قيد التحقق` /
  `en cours de vérification`) and are REJECTED by validation if they
  contain an `article + digit` style citation. No citation appears
  anywhere until provisions are verified during the build.

## The gate (two locks, not one)

1. **Server lock (structural):** the Worker has NO publish, send, or
   contact code path at all. The `/army` response contains drafts +
   `needs_approval: true` + `human_decision: null` only. Nothing the
   server returns is an action.
2. **Browser lock (explicit):** in army mode (`?army=1`), the approval
   card shows the case summary + post draft and three decisions:
   approve / edit / reject (reject records an optional reason in the
   trace). Publish stays disabled until BOTH the existing verification
   check passes AND approval is granted, and the publish action itself
   re-checks both (approve-then-edit cannot bypass it: editing resets
   approval to pending).

## Endpoints

- `POST /` — the original single-call path, UNCHANGED. Default app
  behavior. The fallback when `/army` fails.
- `POST /army { transcript }` — the 5-agent pipeline. 200 = full state
  + trace + gate. 502 = agent failure (error class + agent name only).
  Same guards as `/`: secret required, valid JSON body, transcript
  length-checked, CORS via `ALLOWED_ORIGIN` when set.

## How to try it

Open the app with `?army=1` (e.g. `index.html?army=1`). The structure
step runs the army (trace panel shows each agent + the gate), then the
approval card asks for your decision. Approve → verify → publish works.
Reject → the run stops and publish stays locked. If `/army` fails, the
app falls back to the single-call path and says so in the trace.

Expected latency: 5 sequential model calls, typically ~30–90 seconds
total (each call is a few seconds; the trace shows per-agent timing).
Cost is ~5× a single call — still a fraction of a cent per complaint
at Spark Open pricing, far inside the $100 Baseten credits.

**Reasoning-budget lesson (Oct 29, 2026, found live):** Spark Open is
a reasoning model — one writer call spent ~1841 tokens on internal
reasoning, hit the 2000-token cap (`finish_reason: "length"`), and
returned truncated mid-JSON letters, failing validation 4×. Token
budgets MUST cover reasoning + answer: every agent 4000, Writer (two
long letters) 8000, single-call path 4000. A truncation failure looks
exactly like a bad prompt until you read `finish_reason` + `usage`.
Parse failures now carry a `parseDetail` class (`null` / `empty` /
`unparseable` / `shape`) so the next failure is diagnosable without
ever returning raw model output.

## Deliberately NOT built (Phase 2 scope)

- No server-side decision log (that needs a database binding; the
  Worker is intentionally binding-free). Decisions are logged in the
  browser trace for the demo.
- No Noyce bot link, no admin panel, no multi-key rotation, no
  LangGraph. Those are spec Phase 2/3 items, excluded for the reasons
  above.
