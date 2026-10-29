# NEW_WORK.md — what was built during the hackathon event week

This file exists so a judge can tell, at a glance, what is new here.

## Built during event week (Oct 29+, 2026) — all app code in this repo

### Phase 0 (scaffold)

- `index.html` — complaint input (voice + text), structured-case panel,
  letter panel, public board panel, trace log panel.
- `app.js` — wiring, the hard non-skippable verification check, review
  step, publish flow, board rendering, trace logging, browser speech.
- `mock-model.js` — Phase 0 MOCK structuring + letter templates
  (deterministic, no network, no key). Replaced in Phase 1 by Spark Open
  behind the same contract.
- `styles.css` — phone-first styling, system fonts only.
- This README, NEW_WORK.md, NOTICE.md, LICENSE, `.env.example`,
  `.gitignore`.

### Phase 1 (Oct 29, 2026) — live wiring (Worker proxy)

- `worker-proxy.js` — Cloudflare Worker: single-purpose endpoint that
  takes `{ transcript }`, calls Baseten Spark Open (model id exactly
  `meta-models/muse-spark-open-1026`), validates the model's JSON in
  code, retries max 3 on parse failure, and never returns unparsed
  output. Holds `BASETEN_API_KEY` as a server-side secret only.
- `live-model.js` — browser client: calls the proxy (never Baseten
  directly), normalizes the payload to the exact contract, throws on
  any proxy failure so the app falls back to MOCK honestly.
- `app.js` / `index.html` / `styles.css` — proxy-first wiring, MOCK
  fallback, and a LIVE/MOCK/`MOCK (بديل)` indicator (banner + case
  tag + trace) that shows which layer produced the last case.
- `DEPLOY.md` — the exact phone steps to deploy the Worker and set
  the `BASETEN_API_KEY` secret (dashboard path; no key in the repo).
- Plan adaptation (recorded honestly): the build plan's Phase 1 step 1
  said "replace `mock-model.js` internals with a Baseten client". That
  was NOT done literally, because a direct browser→Baseten client
  would put the API key in browser JavaScript. The proxy is the
  key-safe architecture; `mock-model.js` stays as the offline fallback.
  The function contract is unchanged.

### Phase 2 (Oct 29, 2026) — agent army (Worker-native)

- `worker-proxy.js` — NEW additive route `POST /army`: the Supervisor
  (deterministic code, not a model call) runs 5 specialist Spark Open
  calls in sequence (Listener → Organizer → Researcher → Writer →
  Pressure), each JSON-validated with the same fail-closed retry rules
  as Phase 1, and returns the shared state + trace + a mandatory
  approval gate (`needs_approval: true`, `human_decision: null`). The
  Worker has NO publish/send/contact code path. The original `POST /`
  single-call path is UNCHANGED (same code, same behavior) and is the
  fallback when `/army` fails.
- `live-model.js` — NEW `structureComplaintArmy` client (5-minute
  timeout for 5 sequential calls; throws on any failure so the app
  falls back to the single-call path honestly).
- `app.js` / `index.html` / `styles.css` — NEW army mode (`?army=1`,
  fully guarded: default behavior identical without the flag): agent
  trace panel + approval card (approve / edit / reject, reject records
  an optional reason in the trace). Publish in army mode requires BOTH
  the verification pass AND explicit approval, and the publish action
  re-checks both (edit resets approval to pending).
- `ARMY.md` — full army design + why the spec was adapted (no
  LangGraph: Python cannot run on Workers; no LiteLLM multi-provider
  rotation: the hackathon runtime rule allows Meta models only; no
  Noyce link: the live bot is never touched for the entry).
- Spec adaptation (recorded honestly): the Grok "army" spec asked for
  LangGraph + LiteLLM rotation + later Noyce integration. None of the
  three was done literally, for the reasons above. What WAS built is
  the spec's Phase 1 definition of done — Darija in → organized case +
  AR letter + FR letter + public post + mandatory stop for approval —
  with the same 5 agents and the same gate, on the Meta-only runtime.
- Status correction: the "Deliberately NOT" items below about
  `PROXY_URL` being `""` and the live path being untested describe the
  pre-deploy state. The Worker is now deployed, `PROXY_URL` is set, and
  the live path was proven Worker-side on Oct 29, 2026 (HTTP 200, full
  valid contract payload). The phone test remains the first proof on a
  real phone.

## Pre-existing (NOT built this week, NOT our work)

- Browser Web Speech APIs (SpeechRecognition, SpeechSynthesis) — built
  into the browser. Used for voice in/out only; they are not models.
- Nothing else. No third-party libraries, no copied code, no earlier
  project code.

## Deliberately NOT in this repo yet (Phase 1+)

- A CONFIGURED live path: the proxy + live client exist, but
  `PROXY_URL` in `live-model.js` is still the `""` placeholder until
  the Worker is deployed (DEPLOY.md) — and the live path is UNTESTED
  end to end (the single permitted VM test attempt returned no usable
  model text; see the README caveat). The phone test after deploy is
  the first real proof.
- Verified consumer-protection-law references. The letter template
  carries a clearly-marked placeholder line instead of any article
  number or quoted provision. Adding a real citation requires verifying
  the provision first — that check is a Phase 1/2 task, not a guess.
- Any real company name, any real complaint. Seed board entries use
  obviously fictional names only ("متجر تجريبي" and friends) and are
  labeled demo data in the UI.
