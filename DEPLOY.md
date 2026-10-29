# DEPLOY.md — deploy the Worker proxy (Seg, on his phone)

This is the ONLY deploy step for Phase 1. It puts the Baseten key where
it belongs — as an encrypted secret on Cloudflare's servers — and gives
the app a proxy URL to call. **Nothing in this file, the app, or the
repo ever contains the key itself.**

## What you need in hand

- Your Baseten API key, saved somewhere safe (from the one-time link in
  the Oct 26 Baseten email). **Never paste it in chat, in the app code,
  or in any repo file.**
- A Cloudflare account (dash.cloudflare.com). Log in on your phone.

## Steps

1. **Create the Worker.** Open dash.cloudflare.com → **Workers & Pages**
   → **Create application** → **Workers** → **Get started**. Name it
   `consumer-voice-proxy` (any name works) → **Deploy**. (This creates
   a Worker with default code; you replace it next.)
2. **Paste the proxy code.** Open the new Worker → **Edit code** →
   delete all the default code → paste the FULL contents of
   `worker-proxy.js` from this repo → **Save and deploy** (or
   **Deploy**).
3. **Set the secret — this is the step that holds the key.** Go to
   **Settings** → **Variables** → **Add variable**:
   - **Variable name:** exactly `BASETEN_API_KEY`
   - **Value:** paste your Baseten key
   - Turn ON **Encrypt** (this makes it a secret, not a plain variable)
   - **Save.**
   Do NOT add the key anywhere else (not in the code, not in a plain
   variable, not in the repo).
4. **(Optional, later) Restrict who can call it.** Leave
   `ALLOWED_ORIGIN` unset for the demo. Before any public launch
   beyond the hackathon demo, set it to the app's URL so other sites
   cannot spend this key's credits.
5. **Copy the Worker URL.** It looks like
   `https://consumer-voice-proxy.<your-subdomain>.workers.dev`.
   **Send ONLY this URL to Muse** (the URL is public by nature; the key
   is not — never send the key).
6. **Muse wires it + you test on your phone.** Muse sets `PROXY_URL`
   in `live-model.js` to your Worker URL and pushes. Then open the app,
   speak or type a complaint, and check the banner:
   - Banner shows **LIVE** → the live path works. This is the first
     real proof (see the caveat in README.md).
   - Banner shows **MOCK (بديل)** → the proxy call failed. Check, in
     order: (a) the secret name is exactly `BASETEN_API_KEY` and
     Encrypted, (b) the Worker is deployed (not just saved), (c) the
     URL Muse used matches your Worker URL exactly.

## If the key ever leaks

If the key appears anywhere public (a repo, a screenshot, a chat
message), it is burned: reply to the Baseten email to get a new key,
replace the `BASETEN_API_KEY` secret with the new value, and tell Muse.
Never reuse a leaked key.

## Wrangler alternative (not needed on a phone)

If you ever deploy from a computer instead: `wrangler secret put
BASETEN_API_KEY` (it prompts for the value; the value is never stored
in a file). The dashboard path above is the phone path.
