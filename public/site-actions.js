// OpenScout Agentic Web Node — site-owned browser actions.
// Agent output is data, never executable code.

const DOSSIER_STORE_KEY = "openscout-audit-dossiers-v1";

function readDossiers() {
  try {
    const raw = localStorage.getItem(DOSSIER_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getSiteActions() {
  return [
    {
      name: "get_node_catalog",
      description: "Returns OpenScout's node identity, supported audit capabilities, saved dossier count, and curated Open Agentic Web peer targets.",
      effect: "read",
      availability: "bridge",
      callerOrigins: ["*"],
      timeoutMs: 5000,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      async execute() {
        const dossiers = readDossiers();
        return {
          node: "openscout_node",
          version: "0.3.0",
          capabilities: [
            "github_repo_audit",
            "agentic_web_mvp_0_3_conformance",
            "sly_data_boundary_check",
            "peer_agent_composition"
          ],
          savedDossierCount: dossiers.length,
          curatedPeers: [
            {
              name: "Peer Trust Verifier (Built-in)",
              url: typeof location !== "undefined" ? `${location.origin}/peers/trust_verifier` : "https://openscout.local/peers/trust_verifier"
            },
            {
              name: "Agent Atlas",
              url: "https://agent-atlas-phi.vercel.app/agent_atlas"
            },
            {
              name: "Shutdown Clerk",
              url: "https://shutdown-clerk.pages.dev/shutdown_clerk"
            }
          ]
        };
      }
    },
    {
      name: "inspect_agentic_site",
      description: "Fetches a target site's agent-manifest.json and declared network JSON over HTTPS/HTTP and evaluates Open Agentic Web MVP Profile 0.3 conformance.",
      effect: "read",
      availability: "bridge",
      callerOrigins: ["*"],
      timeoutMs: 12000,
      inputSchema: {
        type: "object",
        properties: {
          siteUrl: {
            type: "string",
            minLength: 8,
            maxLength: 500,
            description: "Site base URL or direct agent-manifest.json URL."
          }
        },
        required: ["siteUrl"],
        additionalProperties: false
      },
      async execute(args, { signal } = {}) {
        const clean = String(args.siteUrl || "").trim().replace(/\/agent-manifest\.json$/i, "").replace(/\/$/, "");
        const manifestUrl = `${clean}/agent-manifest.json`;
        const resp = await fetch(manifestUrl, { signal, cache: "no-store" });
        if (!resp.ok) {
          return {
            ok: false,
            manifestUrl,
            status: resp.status,
            reason: `Manifest fetch returned HTTP ${resp.status}.`
          };
        }
        const manifest = await resp.json();
        const networks = Array.isArray(manifest.networks) ? manifest.networks : [];
        const primary = networks[0] || null;
        let networkValid = false;
        let frontMan = primary?.front_man || null;
        let networkIssues = [];
        let agentCount = 0;

        if (primary?.hocon) {
          const netUrl = /^https?:\/\//i.test(primary.hocon)
            ? primary.hocon
            : `${clean}/${primary.hocon.replace(/^\.\//, "").replace(/^\//, "")}`;
          const netResp = await fetch(netUrl, { signal, cache: "no-store" });
          if (netResp.ok) {
            const netJson = await netResp.json();
            const tools = Array.isArray(netJson.tools) ? netJson.tools : [];
            agentCount = tools.length;
            if (!tools.length) networkIssues.push("Network tools array is empty.");
            if (frontMan && !tools.some((t) => t?.name === frontMan)) {
              networkIssues.push(`Declared front_man '${frontMan}' missing from tools.`);
            }
            networkValid = networkIssues.length === 0;
          } else {
            networkIssues.push(`Network definition fetch returned HTTP ${netResp.status}.`);
          }
        } else {
          networkIssues.push("Primary network entry missing hocon path.");
        }

        return {
          ok: true,
          manifestUrl,
          brand: String(manifest.brand || "Unknown"),
          networkCount: networks.length,
          primaryNetwork: primary?.name || null,
          frontMan,
          agentCount,
          hasLlmRouter: Boolean(manifest.llm_router?.base_url),
          peerPolicyMode: manifest.peer_policy?.mode || (Array.isArray(manifest.allowed_peers) ? "closed" : "unspecified"),
          networkValid,
          issues: networkIssues
        };
      }
    },
    {
      name: "inspect_github_repo",
      description: "Queries the public GitHub REST API for repository health signals (license, stars, open issues, default branch, last push).",
      effect: "read",
      availability: "bridge",
      callerOrigins: ["*"],
      timeoutMs: 10000,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            minLength: 3,
            maxLength: 200,
            description: "GitHub slug owner/repo or https://github.com/owner/repo URL."
          }
        },
        required: ["repo"],
        additionalProperties: false
      },
      async execute(args, { signal } = {}) {
        const raw = String(args.repo || "").trim();
        const match = raw.match(/(?:github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git|\/|$)/i);
        if (!match) {
          return { ok: false, reason: "Expected owner/repo or GitHub repository URL." };
        }
        const slug = match[1];
        const apiUrl = `https://api.github.com/repos/${slug}`;
        const resp = await fetch(apiUrl, {
          signal,
          headers: { Accept: "application/vnd.github+json" }
        });
        if (!resp.ok) {
          return {
            ok: false,
            slug,
            status: resp.status,
            reason: `GitHub API returned HTTP ${resp.status}.`
          };
        }
        const data = await resp.json();
        return {
          ok: true,
          slug: data.full_name,
          description: data.description || "",
          license: data.license?.spdx_id || "NONE",
          stars: data.stargazers_count ?? 0,
          forks: data.forks_count ?? 0,
          openIssues: data.open_issues_count ?? 0,
          defaultBranch: data.default_branch || "main",
          pushedAt: data.pushed_at || "",
          archived: Boolean(data.archived),
          htmlUrl: data.html_url || `https://github.com/${slug}`
        };
      }
    },
    {
      name: "save_audit_dossier",
      description: "Persists a reviewed due-diligence dossier receipt into origin-scoped browser storage. Requires explicit user confirmation.",
      effect: "write",
      availability: "local-only",
      callerOrigins: [],
      timeoutMs: 5000,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", minLength: 1, maxLength: 300 },
          verdict: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
          summary: { type: "string", minLength: 5, maxLength: 2000 }
        },
        required: ["target", "verdict", "summary"],
        additionalProperties: false
      },
      async execute(args, { requestId } = {}) {
        const current = readDossiers();
        const existing = current.find((item) => item.requestId === requestId);
        if (existing) {
          return { saved: true, idempotentReplay: true, dossierId: existing.id };
        }
        const entry = {
          id: `dos_${Date.now().toString(36)}`,
          requestId: requestId || `req_${Date.now().toString(36)}`,
          target: String(args.target),
          verdict: String(args.verdict),
          summary: String(args.summary),
          savedAt: new Date().toISOString()
        };
        const updated = [entry, ...current].slice(0, 25);
        localStorage.setItem(DOSSIER_STORE_KEY, JSON.stringify(updated));
        return {
          saved: true,
          dossierId: entry.id,
          savedAt: entry.savedAt,
          totalStored: updated.length
        };
      }
    }
  ];
}
