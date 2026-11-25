import { redactSecretFromString, routerRequiresKey } from "./byok";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmCompletionInput {
  agentName: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
}

export interface LlmCompletionResult {
  content: string;
  toolCalls: ToolCallRequest[];
  modelUsed: string;
  routerUsed: string;
}

export class LlmClient {
  readonly baseUrl: string;
  readonly mock: boolean;
  readonly publisherFunded: boolean;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    baseUrl: string;
    apiKey?: string;
    mock?: boolean;
    publisherFunded?: boolean;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = String(options.baseUrl || "browser://mock").replace(/\/$/, "");
    this.mock = Boolean(options.mock) || this.baseUrl === "browser://mock";
    this.publisherFunded = Boolean(options.publisherFunded);
    this.apiKey = this.publisherFunded ? "" : String(options.apiKey || "");
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletionResult> {
    if (this.mock) {
      return this.completeMock(input);
    }

    if (routerRequiresKey(this.baseUrl) && !this.apiKey) {
      throw new Error(
        `Missing API key for router '${this.baseUrl}'. Enter a BYOK key or switch to Deterministic Browser Mock.`
      );
    }

    const endpoint = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (this.baseUrl.includes("api.anthropic.com")) {
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }

    const body: Record<string, unknown> = {
      model: input.model,
      messages: input.messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.name) msg.name = m.name;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.tool_calls && m.tool_calls.length > 0) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      temperature: 0.2,
    };
    if (input.tools.length > 0) {
      body.tools = input.tools;
      body.tool_choice = "auto";
    }

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(redactSecretFromString(`LLM network error calling ${endpoint}: ${msg}`, this.apiKey));
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        redactSecretFromString(
          `LLM HTTP ${response.status} from ${this.baseUrl}: ${text.slice(0, 280)}`,
          this.apiKey
        )
      );
    }

    const data = (await response.json()) as {
      model?: string;
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: ToolCallRequest[];
        };
      }>;
    };

    const msg = data.choices?.[0]?.message;
    return {
      content: String(msg?.content || ""),
      toolCalls: Array.isArray(msg?.tool_calls) ? msg.tool_calls : [],
      modelUsed: data.model || input.model,
      routerUsed: this.baseUrl,
    };
  }

  private completeMock(input: LlmCompletionInput): LlmCompletionResult {
    const toolNames = new Set(input.tools.map((t) => t.function.name));
    const calledTools = new Set(
      input.messages
        .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
        .flatMap((m) => m.tool_calls!.map((c) => c.function.name))
    );
    const toolResults = input.messages.filter((m) => m.role === "tool");
    const lastUser = [...input.messages].reverse().find((m) => m.role === "user")?.content || "";
    const lower = lastUser.toLowerCase();

    const makeCall = (name: string, args: Record<string, unknown>): LlmCompletionResult => ({
      content: "",
      toolCalls: [
        {
          id: `mock_call_${name}_${calledTools.size + 1}`,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(args),
          },
        },
      ],
      modelUsed: "openscout-mock-v1",
      routerUsed: "browser://mock",
    });

    if (input.agentName === "scout_front") {
      const repoMatch = lastUser.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i) ||
        lastUser.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
      const urlMatch = lastUser.match(/https?:\/\/[^\s"'<>]+/i);
      const isGithubUrl = Boolean(urlMatch && /github\.com/i.test(urlMatch[0]));

      if ((repoMatch || lower.includes("repo") || lower.includes("github")) && toolNames.has("repo_auditor") && !calledTools.has("repo_auditor")) {
        const slug = repoMatch ? repoMatch[1].replace(/\.git$/i, "") : "cognizant-ai-labs/agentic-web";
        return makeCall("repo_auditor", { repo: slug });
      }

      if (
        (lower.includes("conformance") || lower.includes("manifest") || lower.includes("mvp") || lower.includes("site") || (urlMatch && !isGithubUrl)) &&
        toolNames.has("spec_conformance_auditor") &&
        !calledTools.has("spec_conformance_auditor")
      ) {
        const target = urlMatch && !isGithubUrl ? urlMatch[0] : (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:5173");
        return makeCall("spec_conformance_auditor", { target_url: target });
      }

      const remoteToolName = [...toolNames].find((name) => !["repo_auditor", "spec_conformance_auditor", "risk_synthesizer"].includes(name) && !name.startsWith("website_"));
      if (
        (lower.includes("peer") || lower.includes("verifier") || lower.includes("trust") || lower.includes("sly_data")) &&
        remoteToolName &&
        !calledTools.has(remoteToolName)
      ) {
        return makeCall(remoteToolName, {
          request: `Verify trust posture and sly_data boundary isolation for: ${lastUser.slice(0, 90)}`,
        });
      }

      if (toolResults.length === 0 && toolNames.has("website_get_node_catalog") && !calledTools.has("website_get_node_catalog")) {
        return makeCall("website_get_node_catalog", {});
      }

      if (toolResults.length > 0 && toolNames.has("risk_synthesizer") && !calledTools.has("risk_synthesizer")) {
        const combined = toolResults.map((r) => `${r.name || "tool"}: ${r.content}`).join("\n");
        return makeCall("risk_synthesizer", { findings: combined.slice(0, 3500) });
      }

      if ((lower.includes("save") || lower.includes("dossier")) && toolNames.has("website_save_audit_dossier") && !calledTools.has("website_save_audit_dossier")) {
        return makeCall("website_save_audit_dossier", {
          target: repoMatch?.[1] || urlMatch?.[0] || "openscout_node",
          verdict: "PASS",
          summary: `Verified due-diligence scan for ${repoMatch?.[1] || urlMatch?.[0] || "local node"} via OpenScout MVP 0.3 runtime.`,
        });
      }

      const summaryBlocks = toolResults.map((r) => `- **${r.name || "tool"}**: ${r.content}`);
      return {
        content: summaryBlocks.length
          ? `### OpenScout Due-Diligence Report (Mock Mode)\n\n${summaryBlocks.join("\n")}`
          : "OpenScout is ready. Ask me to audit a GitHub repo (`owner/repo`), inspect an Open Agentic Web site URL, or invoke a consented peer node.",
        toolCalls: [],
        modelUsed: "openscout-mock-v1",
        routerUsed: "browser://mock",
      };
    }

    if (input.agentName === "repo_auditor") {
      if (toolNames.has("website_inspect_github_repo") && !calledTools.has("website_inspect_github_repo")) {
        let repo = "cognizant-ai-labs/agentic-web";
        try {
          const parsed = JSON.parse(lastUser) as { repo?: string };
          if (parsed.repo) repo = parsed.repo;
        } catch {
          const m = lastUser.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
          if (m) repo = m[1];
        }
        return makeCall("website_inspect_github_repo", { repo });
      }
      const res = toolResults[0]?.content || "{}";
      return {
        content: `Repository audit output: ${res}`,
        toolCalls: [],
        modelUsed: "openscout-mock-v1",
        routerUsed: "browser://mock",
      };
    }

    if (input.agentName === "spec_conformance_auditor") {
      if (toolNames.has("website_inspect_agentic_site") && !calledTools.has("website_inspect_agentic_site")) {
        let targetUrl = typeof location !== "undefined" ? location.origin : "http://127.0.0.1:5173";
        try {
          const parsed = JSON.parse(lastUser) as { target_url?: string };
          if (parsed.target_url) targetUrl = parsed.target_url;
        } catch {
          const m = lastUser.match(/https?:\/\/[^\s"']+/i);
          if (m) targetUrl = m[0];
        }
        return makeCall("website_inspect_agentic_site", { siteUrl: targetUrl });
      }
      const res = toolResults[0]?.content || "{}";
      return {
        content: `MVP Profile 0.3 conformance audit output: ${res}`,
        toolCalls: [],
        modelUsed: "openscout-mock-v1",
        routerUsed: "browser://mock",
      };
    }

    if (input.agentName === "risk_synthesizer") {
      let findings = lastUser;
      try {
        const parsed = JSON.parse(lastUser) as { findings?: string };
        if (parsed.findings) findings = parsed.findings;
      } catch {
        // use raw text
      }
      return {
        content: `| Signal | Status | Grounded Evidence |\n|---|---|---|\n| Multi-Agent Delegation | PASS | Executed inside browser runtime |\n| Grounded Tool Data | PASS | ${findings.slice(0, 180).replace(/\|/g, "/")} |`,
        toolCalls: [],
        modelUsed: "openscout-mock-v1",
        routerUsed: "browser://mock",
      };
    }

    if (input.agentName === "verifier_front" && toolNames.has("policy_checker") && !calledTools.has("policy_checker")) {
      return makeCall("policy_checker", { subject: lastUser.slice(0, 120) });
    }

    return {
      content: `Peer agent '${input.agentName}' completed verification inside caller browser on router '${this.baseUrl}'. Tool evidence: ${toolResults.map((r) => r.content).join(" | ") || lastUser.slice(0, 140)}`,
      toolCalls: [],
      modelUsed: "openscout-mock-v1",
      routerUsed: "browser://mock",
    };
  }
}
