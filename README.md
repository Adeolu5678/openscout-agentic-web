# OpenScout Agentic Web Node

OpenScout is an open, static-deployable multi-agent website built for the **Open Agentic Web Challenge** (`MVP Profile 0.3`). It acts as an autonomous technical due-diligence and conformance auditor node that evaluates public GitHub repositories, inspects Open Agentic Web manifests and resolved `.network.json` graphs, and composes peer agentic sites directly in the visitor's browser.

## Architecture & MVP Profile 0.3 Compliance

- **Public Discovery Artifacts (`public/`)**
  - `public/agent-manifest.json` — declares `openscout_node`, `front_man` (`scout_front`), `llm_router`, `peer_policy`, `allowed_peers`, `linking` (`nsdeploy-link/v1`), and `actions` (`site-actions.js` + `bridge/action-bridge.html`).
  - `public/openscout_node.network.json` — resolved, data-only Neuro SAN JSON network (`scout_front` -> `repo_auditor`, `spec_conformance_auditor`, `risk_synthesizer`, plus `peer_trust_verifier` link slot) with explicit `allow.to_downstream.sly_data` and `allow.to_upstream.sly_data` policies.
  - `public/links.json` — publisher default link bindings (`version: 1`).
  - `public/.well-known/nsdeploy.json`, `public/.well-known/nsdeploy-agent.json`, `public/.well-known/agent-card.json` — optional discovery metadata.
  - `public/peers/agent-manifest.json` & `public/peers/trust_verifier.network.json` — self-contained peer verification node (`trust_verifier`) for testing cross-network fetch-and-run-locally composition and `sly_data` isolation.
- **Browser Runtime (`src/runtime/`)**
  - `src/runtime/spec.ts` — MVP Profile 0.3 manifest & Neuro SAN network validator, `findFrontMan`, `classifyTool`, `commondefs` expansion, `manifestAllowsPeer`, and `sly_data` deny-by-default filtering.
  - `src/runtime/byok.ts` — origin-scoped `localStorage` + tab `sessionStorage` + loopback-only cookie BYOK profile manager (`browser://mock`, OpenAI, Google Gemini OpenAI-compatible CORS endpoint, OpenRouter, Ollama).
  - `src/runtime/actions.ts` — schema-validated site action registry with 64 KB payload bounds, prototype-pollution guards, user confirmation gate before writes, `requestId` idempotency, and unknown-outcome timeout handling.
  - `src/runtime/llm.ts` & `src/runtime/engine.ts` — bounded multi-agent loop, consent gate before third-party origin contact, exact peer network resolution, cycle/depth/budget enforcement, and peer router locking (peers run on the caller's active router and never receive visitor BYOK keys).

## Local Setup & Verification

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check:lf
```

Start the dev server:

```bash
npm run dev
```

## License

Licensed under the [Apache License 2.0](./LICENSE).
