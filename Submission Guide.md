# OpenScout Submission Guide

Deployment checklist and <2-minute demo script for the **Open Agentic Web Challenge** (`https://cognizant-agenticweb.devpost.com/`).

## Static HTTPS + CORS Deployment

OpenScout compiles to a self-contained static bundle (`dist/`) that publishes `agent-manifest.json`, `openscout_node.network.json`, `links.json`, `site-actions.js`, `.well-known/*`, `bridge/*`, and `peers/*` with permissive public `GET` CORS headers.

### Option 1: Cloudflare Pages

1. Build locally or connect the repository in Cloudflare Pages:
   - Build command: `npm run build`
   - Build output directory: `dist`
2. `public/_headers` is copied automatically to `dist/_headers` and serves `Access-Control-Allow-Origin: *` on all public agent artifacts.

### Option 2: Vercel

1. Import the `open-agentic-web` directory in Vercel (`npx vercel --prod`).
2. `vercel.json` configures `Access-Control-Allow-Origin: *` and `GET, HEAD, OPTIONS` headers for `/agent-manifest.json`, `/openscout_node.network.json`, `/links.json`, `/site-actions.js`, `/.well-known/*`, `/bridge/*`, and `/peers/*`.

### Option 3: GitHub Pages

1. Run `npm run build` and deploy `dist/` to the `gh-pages` branch (GitHub Pages serves static files over HTTPS with `Access-Control-Allow-Origin: *` by default).
2. If hosted under a subpath (e.g. `https://<user>.github.io/<repo>/`), set `base: "./"` in `vite.config.ts` prior to building.

## Under-2-Minute Demo Script

1. **0:00 – 0:25 | Node & Spec Conformance Check**
   - Open the deployed HTTPS URL. Point out the top status pill (`MVP 0.3 Valid (scout_front)`) and click `agent-manifest.json` and `.network.json` links to show declarative public artifacts.
2. **0:25 – 0:55 | Multi-Agent Due-Diligence Execution (Mock or BYOK)**
   - Click the sample query: *"Audit https://github.com/cognizant-ai-labs/agentic-web..."*
   - Watch the Live Execution Trace show `scout_front -> repo_auditor -> website_inspect_github_repo -> risk_synthesizer` running inside the browser.
   - Optionally open **Inference & BYOK Router**, choose OpenAI or Google Gemini, paste a key, and rerun to show direct browser CORS inference without any backend server.
3. **0:55 – 1:30 | Consented Peer Composition & `sly_data` Isolation**
   - In **Peer Composition & Consent**, keep `Built-in Trust Verifier` (or select `Agent Atlas` / `Shutdown Clerk`) with the simulated `sly_data` (`caller_audit_id` + `secret_token`) and click **Invoke Peer (With Consent)**.
   - Highlight the Consent Modal showing the exact origin, network name, 140-character preview, and that `secret_token` is stripped (`Allowed: caller_audit_id` only) while the peer inherits the caller's router and never sees the BYOK key.
4. **1:30 – 1:55 | User-Owned Write Confirmation**
   - Ask OpenScout to *"Run a due-diligence scan on a public repo and save an audit dossier."*
   - Approve the **Confirm Site Write Action** modal and show the saved dossier receipt under **Saved Audit Dossiers**.
