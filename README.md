# صوت المستهلك — Consumer Voice

**Pre-existing vs built this week:** pre-existing = browser Web Speech APIs
only (SpeechRecognition + SpeechSynthesis, built into the browser — they are
not models and no model is called for voice). **All app code in this repo was
built during the Meta Global AI Developer Hackathon event week (Oct 29+,
2026)** — nothing here is copied, imported, or adapted from any earlier
project, and no pre-existing product code is reused.

## What it is

A public, voice-first, Darija consumer-complaint platform for Morocco.
One sharp problem: a Moroccan consumer who was cheated by a company and
cannot write a formal complaint has no power against that company.

- **Speak (or type) a complaint in Darija** → the app produces a structured
  case: company, issue, what you want, amount if any.
- **Formal letter draft** in Arabic, plus a French version — ready to file
  through the official channel. This is the closed loop: the complaint does
  not end at a listing.
- **Public listing + company score** — public pressure alongside the
  official filing track.
- **Before anything publishes, a HARD, non-skippable verification check
  runs** (company + issue + demand present; forbidden content blocked).
  Fail → visible feedback → fix → re-check → only then publish.
  This is the Agents-102 lesson applied: verification lives inside the
  publish step, not as an optional extra.

Moderation, by design: the user reviews and corrects the case before
publishing; published complaints are labeled as **user claims** (allegations,
not verdicts); every case has a company-reply slot and a report button.

## What it is NOT

- Not a chatbot, not legal advice, not a court. The letter is a **draft**
  the user reviews and sends in their own name, with their own facts.
- Not a verdict machine: a published case is a claim awaiting the
  company's reply, never a proven finding.
- Seed board entries are **obviously fictional demo data**, labeled as
  such in the UI. No real company is ever named with a fake complaint.

## Architecture

```
Darija speech ──► browser SpeechRecognition ──► model structures the case
                                                            │
                                            MANDATORY CHECK (Agents 102):
                                            company + issue + demand present,
                                            forbidden content blocked
                                                            │ fail → feedback → fix → re-check
                                                            │ pass → user reviews → publishes
Structured case ──► formal letter draft (AR + FR) ──► filing-ready
Public case ──► board + company score + company-reply slot + report button
Every step ──► visible trace log (transcript, fields, check result, publish)
```

- **Brain (Phase 1): Muse Spark Open via Baseten** — model id exactly
  `meta-models/muse-spark-open-1026`, base URL
  `https://inference.baseten.co/v1` (OpenAI-compatible). This is the ONLY
  model the app will call at runtime. **The browser never calls Baseten
  directly**: it calls the Worker proxy (`worker-proxy.js`), which holds
  `BASETEN_API_KEY` as a server-side secret. The key never appears in
  browser code, this repo, or any log.
- **Voice in/out: browser Web Speech API** — organizer-confirmed allowed;
  it is not a model call.
- **Phase 0 MOCK model layer** (`mock-model.js`) — deterministic
  keyword→structure mapping + letter templates, clearly marked MOCK in
  code and in the UI. It makes no network calls and needs no key.
  **Phase 1 keeps it as the offline fallback**; the default path is the
  live proxy (`live-model.js`) behind the SAME function contract; the
  UI, trace, and check contract stay unchanged.
- **Law grounding: PLACEHOLDER.** Letters will cite Morocco's
  consumer-protection law only after its provisions are verified during
  the build. No article number and no quoted provision appears anywhere
  in this repo until that verification happens (see NEW_WORK.md).

## Phase 1 — live model wiring (Worker proxy)

```
Browser ──POST { transcript }──► Worker proxy ──► Baseten Spark Open
   ▲                                (validates JSON in code,
   │                                 retries max 3 on parse failure,
   │                                 never returns unparsed output)
   └──── 200 { company, issue, demand, amount, category,
                letterAr, letterFr, extractionNotes }
```

- **Files:** `worker-proxy.js` (the Worker; single-purpose endpoint, not
  a generic relay — the client cannot ask for a different model or
  messages), `live-model.js` (browser client; contains no key, no
  Authorization header, no Baseten URL — only the proxy URL).
- **Config:** `LIVE_CONFIG.PROXY_URL` in `live-model.js` — currently
  `""` (placeholder). While it is empty, the app runs on the MOCK layer
  and the banner says so. Set it to the deployed Worker URL after
  following `DEPLOY.md`.
- **Fallback + honesty:** the proxy is tried first. If it is unset or
  the call fails (network, timeout, non-2xx, parse failure after
  retries), the app falls back to the MOCK layer and the banner + tag +
  trace say so (`MOCK (بديل)`). Nothing ever silently pretends to be
  live: the indicator shows `LIVE` only after a live call succeeds.
- **Plan note:** the build plan's Phase 1 step 1 said "replace
  `mock-model.js` internals with a Baseten client". That was adapted:
  a direct browser→Baseten client would put the API key in browser
  JavaScript (a public repo would leak it), so the proxy is the
  key-safe architecture and the MOCK layer stays as the offline
  fallback. The function contract is unchanged.
- **⚠️ LIVE-PATH CAVEAT (read before demoing): the live path is
  UNTESTED end to end.** Live Baseten calls from the build VM are
  blocked/unreliable (earlier attempts timed out in the VM's egress
  tunnel; the single permitted test attempt on Oct 29 completed in
  ~29s but returned no usable model text — `content: null`, not the
  expected reply — so the model-call contract is NOT proven). The
  proxy + client logic is verified locally against stubs (see below),
  but the first real proof of the live path comes from the phone test
  after deploy (DEPLOY.md step 6). Do not claim the live path works
  until that test shows the `LIVE` banner on a real structuring call.

## How to run

No build step, no dependencies, no key needed for Phase 0:

```bash
# Any static server, or just open the file:
python3 -m http.server 8000
# then open http://localhost:8000/ in a browser (Chrome/Edge for speech)
```

SpeechRecognition needs a Chromium-based browser and a microphone
permission; without it, typing works fully. Everything else (structuring,
check, letters, board) works offline in Phase 0.

With `PROXY_URL` unset (the default), the app runs on the MOCK layer.
To run live: deploy the Worker and set the secret per `DEPLOY.md`,
then set `PROXY_URL` in `live-model.js` to the Worker URL.

## Demo (submission asset, separate from this repo)

3-minute video, target exactly 3:00, English-understandable (subtitles on
Darija moments): one real person, one real grievance, speaks in Darija →
structured case + formal letter + public listing, live. Working parts vs
simulated parts are labeled in the video. Seed board data is labeled demo
data wherever it appears.
