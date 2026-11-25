import {
  ActionConfirmationItem,
  ActionRegistry,
  SiteActionDefinition,
} from "./actions";
import {
  redactSecretFromString,
  selectPeerRouter,
  selectTopRouter,
  type ActiveRouterSelection,
} from "./byok";
import { LlmClient, type ChatMessage, type ToolSchema } from "./llm";
import {
  classifyTool,
  filterConfig,
  filterSlyData,
  manifestAllowsPeer,
  parsePeerTarget,
  redactSlyData,
  validateManifest,
  validateNetwork,
  type AgentManifest,
  type AgentSpec,
  type NetworkConfig,
} from "./spec";

export interface TraceEvent {
  id: string;
  timestamp: string;
  kind:
    | "compile"
    | "agent"
    | "tool"
    | "remote_fetch"
    | "remote_call"
    | "consent"
    | "action_confirm"
    | "sly_data_boundary"
    | "error"
    | "run";
  detail: Record<string, unknown>;
}

export interface ConsentRequest {
  peerOrigin: string;
  peerUrl: string;
  networkName: string;
  purpose: string;
  requestPreview: string;
  allowedSlyKeys: string[];
}

export type ConsentDecision = "allow" | "always" | "decline";

export interface EngineOptions {
  originUrl?: string;
  byokKey?: string;
  routerOverride?: string;
  modelOverride?: string;
  fetchImpl?: typeof fetch;
  siteActions?: SiteActionDefinition[];
  onConsent?: (req: ConsentRequest) => Promise<ConsentDecision>;
  onActionConfirm?: (items: ActionConfirmationItem[]) => Promise<boolean>;
  onLinkRequired?: (info: { reference: string; sourceNetwork: string; sourceOrigin: string }) => Promise<string | null>;
  onTrace?: (event: TraceEvent) => void;
  maxDepth?: number;
  maxRemoteCalls?: number;
  maxCallsPerPeer?: number;
  maxAgentCalls?: number;
  timeoutMs?: number;
}

interface CompiledNode {
  networkName: string;
  frontMan: string;
  config: NetworkConfig;
  manifest: AgentManifest;
  base: string;
  llm: LlmClient;
  links: Record<string, string>;
}

interface CompositionBudget {
  remoteCalls: number;
  peerCalls: Map<string, number>;
  maxRemoteCalls: number;
  maxCallsPerPeer: number;
  agentCalls: number;
  maxAgentCalls: number;
  deadline: number;
}

export interface RunTurnResult {
  turnId: string;
  text: string;
  routerUsed: string;
  modelUsed: string;
  trace: TraceEvent[];
}

export class OpenAgenticEngine {
  readonly originUrl: string;
  private fetchImpl: typeof fetch;
  private byokKey: string;
  private routerOverride: string;
  private modelOverride: string;
  private siteActionsOverride?: SiteActionDefinition[];
  private maxDepth: number;
  private maxRemoteCalls: number;
  private maxCallsPerPeer: number;
  private maxAgentCalls: number;
  private timeoutMs: number;

  onConsent?: (req: ConsentRequest) => Promise<ConsentDecision>;
  onActionConfirm: (items: ActionConfirmationItem[]) => Promise<boolean>;
  onLinkRequired?: (info: { reference: string; sourceNetwork: string; sourceOrigin: string }) => Promise<string | null>;
  onTrace?: (event: TraceEvent) => void;

  readonly actions = new ActionRegistry();
  readonly traceLog: TraceEvent[] = [];
  readonly runtimeAllowedPeers = new Set<string>();
  private consentDecisions = new Map<string, "always">();
  private peerCache = new Map<string, CompiledNode>();
  private userRouter: ActiveRouterSelection | null = null;
  top: CompiledNode | null = null;
  history: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(options: EngineOptions = {}) {
    this.originUrl = (
      options.originUrl ||
      (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:5173")
    ).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
    this.byokKey = options.byokKey || "";
    this.routerOverride = options.routerOverride || "";
    this.modelOverride = options.modelOverride || "";
    this.siteActionsOverride = options.siteActions;
    this.onConsent = options.onConsent;
    this.onActionConfirm = options.onActionConfirm || (async () => false);
    this.onLinkRequired = options.onLinkRequired;
    this.onTrace = options.onTrace;
    this.maxDepth = options.maxDepth ?? 5;
    this.maxRemoteCalls = options.maxRemoteCalls ?? 4;
    this.maxCallsPerPeer = options.maxCallsPerPeer ?? 2;
    this.maxAgentCalls = options.maxAgentCalls ?? 24;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  private emit(kind: TraceEvent["kind"], detail: Record<string, unknown>): void {
    const safeJson = redactSecretFromString(JSON.stringify(detail), this.byokKey);
    const event: TraceEvent = {
      id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      kind,
      detail: JSON.parse(safeJson) as Record<string, unknown>,
    };
    this.traceLog.push(event);
    this.onTrace?.(event);
  }

  updateInferenceConfig(config: {
    routerOverride?: string;
    byokKey?: string;
    modelOverride?: string;
  }): void {
    if (config.routerOverride !== undefined) this.routerOverride = config.routerOverride;
    if (config.byokKey !== undefined) this.byokKey = config.byokKey;
    if (config.modelOverride !== undefined) this.modelOverride = config.modelOverride;

    if (this.top) {
      const selected = selectTopRouter(
        this.top.manifest,
        this.routerOverride,
        this.byokKey,
        this.modelOverride
      );
      this.userRouter = selected;
      this.top.llm = new LlmClient({
        baseUrl: selected.baseUrl,
        apiKey: selected.publisherFunded ? "" : this.byokKey,
        mock: selected.mock,
        publisherFunded: selected.publisherFunded,
        fetchImpl: this.fetchImpl,
      });
      // Re-bind cached peers to caller's new router so they never retain stale routers.
      for (const peer of this.peerCache.values()) {
        const peerRouter = selectPeerRouter(selected);
        peer.llm = new LlmClient({
          baseUrl: peerRouter.baseUrl,
          apiKey: peerRouter.publisherFunded ? "" : this.byokKey,
          mock: peerRouter.mock,
          publisherFunded: peerRouter.publisherFunded,
          fetchImpl: this.fetchImpl,
        });
      }
    }
  }

  getActiveRouterInfo(): ActiveRouterSelection | null {
    return this.userRouter;
  }

  resetHistory(): void {
    this.history = [];
  }

  clearConsentCache(): void {
    this.consentDecisions.clear();
  }

  async runPeerQuery(
    peerUrl: string,
    requestText: string,
    slyData: Record<string, unknown> = {}
  ): Promise<{ text: string; trace: TraceEvent[] }> {
    if (!this.top) await this.loadTop();
    const top = this.top!;
    const startIdx = this.traceLog.length;
    const frontSpec = top.config.tools.find((t) => t.name === top.frontMan) || null;
    const parsed = parsePeerTarget(peerUrl, this.originUrl);
    this.runtimeAllowedPeers.add(parsed.origin);

    const budget: CompositionBudget = {
      remoteCalls: 0,
      peerCalls: new Map(),
      maxRemoteCalls: this.maxRemoteCalls,
      maxCallsPerPeer: this.maxCallsPerPeer,
      agentCalls: 0,
      maxAgentCalls: this.maxAgentCalls,
      deadline: Date.now() + this.timeoutMs,
    };
    const chain = [`${top.base}::${top.networkName}`];
    const text = await this.invokeRemotePeer(
      peerUrl,
      requestText,
      slyData,
      frontSpec,
      top.manifest,
      chain,
      budget
    );
    return { text, trace: this.traceLog.slice(startIdx) };
  }

  async loadTop(): Promise<{ manifest: AgentManifest; network: NetworkConfig; frontMan: string }> {
    const manifestUrl = `${this.originUrl}/agent-manifest.json`;
    const manifestResp = await this.fetchImpl(manifestUrl, { cache: "no-store", credentials: "omit" });
    if (!manifestResp.ok) {
      throw new Error(`Failed to fetch manifest ${manifestUrl}: HTTP ${manifestResp.status}`);
    }
    const manifest = (await manifestResp.json()) as AgentManifest;
    const manifestCheck = validateManifest(manifest);
    if (!manifestCheck.valid) {
      throw new Error(`Invalid agent-manifest.json: ${manifestCheck.errors.join("; ")}`);
    }

    const entry = manifest.networks[0];
    const networkUrl = this.resolveUrl(this.originUrl, entry.hocon);
    const netResp = await this.fetchImpl(networkUrl, { cache: "no-store", credentials: "omit" });
    if (!netResp.ok) {
      throw new Error(`Failed to fetch network ${networkUrl}: HTTP ${netResp.status}`);
    }
    const rawNet = (await netResp.json()) as NetworkConfig;
    const config = filterConfig(rawNet);
    const netCheck = validateNetwork(config);
    if (!netCheck.valid || !netCheck.frontMan) {
      throw new Error(`Network '${entry.name}' validation failed: ${netCheck.errors.join("; ")}`);
    }
    if (entry.front_man && entry.front_man !== netCheck.frontMan) {
      throw new Error(
        `Manifest front_man '${entry.front_man}' does not match network front agent '${netCheck.frontMan}'.`
      );
    }

    const links = await this.loadPublishedLinks(this.originUrl, entry.name);
    const selected = selectTopRouter(manifest, this.routerOverride, this.byokKey, this.modelOverride);
    this.userRouter = selected;

    const llm = new LlmClient({
      baseUrl: selected.baseUrl,
      apiKey: selected.publisherFunded ? "" : this.byokKey,
      mock: selected.mock,
      publisherFunded: selected.publisherFunded,
      fetchImpl: this.fetchImpl,
    });

    this.top = {
      networkName: entry.name,
      frontMan: netCheck.frontMan,
      config,
      manifest,
      base: this.originUrl,
      llm,
      links,
    };

    if (this.siteActionsOverride) {
      for (const action of this.siteActionsOverride) {
        this.actions.register({ base: this.originUrl, network: entry.name }, action);
      }
    } else if (manifest.actions?.module && typeof window !== "undefined") {
      try {
        const modUrl = this.resolveUrl(this.originUrl, manifest.actions.module);
        const mod = (await import(/* @vite-ignore */ modUrl)) as {
          getSiteActions?: () => SiteActionDefinition[];
        };
        if (typeof mod.getSiteActions === "function") {
          for (const action of mod.getSiteActions()) {
            this.actions.register({ base: this.originUrl, network: entry.name }, action);
          }
        }
      } catch (err) {
        this.emit("error", {
          stage: "load_actions",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.emit("compile", {
      network: entry.name,
      frontMan: netCheck.frontMan,
      router: selected.baseUrl,
      mock: selected.mock,
      registeredActions: this.actions.catalog({ base: this.originUrl, network: entry.name }).map((a) => a.name),
    });

    return { manifest, network: config, frontMan: netCheck.frontMan };
  }

  private resolveUrl(base: string, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${base.replace(/\/$/, "")}/${path.replace(/^\.\//, "").replace(/^\//, "")}`;
  }

  private async loadPublishedLinks(base: string, networkName: string): Promise<Record<string, string>> {
    try {
      const resp = await this.fetchImpl(`${base.replace(/\/$/, "")}/links.json`, {
        cache: "no-store",
        credentials: "omit",
      });
      if (!resp.ok) return {};
      const doc = (await resp.json()) as { networks?: Record<string, Record<string, string>> };
      return doc?.networks?.[networkName] || {};
    } catch {
      return {};
    }
  }

  bindLocalLink(reference: string, targetUrl: string): string {
    if (!this.top) throw new Error("Top network is not loaded.");
    const parsed = parsePeerTarget(targetUrl, this.originUrl);
    this.top.links[reference] = parsed.url;
    this.runtimeAllowedPeers.add(parsed.origin);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(`openscout-link-v1::${this.originUrl}::${this.top.networkName}::${reference}`, parsed.url);
      }
    } catch {
      // ignore
    }
    return parsed.url;
  }

  private getStoredLink(reference: string): string {
    if (!this.top) return "";
    if (this.top.links[reference]) return this.top.links[reference];
    try {
      if (typeof localStorage !== "undefined") {
        return localStorage.getItem(`openscout-link-v1::${this.originUrl}::${this.top.networkName}::${reference}`) || "";
      }
    } catch {
      // ignore
    }
    return "";
  }

  async runTurn(
    userText: string,
    options: { slyData?: Record<string, unknown> } = {}
  ): Promise<RunTurnResult> {
    if (!this.top) await this.loadTop();
    const top = this.top!;
    const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const startIdx = this.traceLog.length;

    this.emit("run", {
      turnId,
      network: top.networkName,
      inputPreview: userText.slice(0, 140),
      slyDataKeys: Object.keys(options.slyData || {}),
    });

    const budget: CompositionBudget = {
      remoteCalls: 0,
      peerCalls: new Map(),
      maxRemoteCalls: this.maxRemoteCalls,
      maxCallsPerPeer: this.maxCallsPerPeer,
      agentCalls: 0,
      maxAgentCalls: this.maxAgentCalls,
      deadline: Date.now() + this.timeoutMs,
    };

    const chain = [`${top.base}::${top.networkName}`];
    const response = await this.executeAgent(
      top,
      top.frontMan,
      userText,
      options.slyData || {},
      chain,
      budget,
      true
    );

    this.history.push({ role: "user", content: userText });
    this.history.push({ role: "assistant", content: response.text });
    if (this.history.length > 24) this.history = this.history.slice(-24);

    return {
      turnId,
      text: response.text,
      routerUsed: response.routerUsed,
      modelUsed: response.modelUsed,
      trace: this.traceLog.slice(startIdx),
    };
  }

  private async executeAgent(
    node: CompiledNode,
    agentName: string,
    userText: string,
    slyData: Record<string, unknown>,
    chain: string[],
    budget: CompositionBudget,
    isTopFront: boolean
  ): Promise<{ text: string; routerUsed: string; modelUsed: string }> {
    if (Date.now() > budget.deadline) {
      throw new Error("Execution deadline exceeded.");
    }
    budget.agentCalls += 1;
    if (budget.agentCalls > budget.maxAgentCalls) {
      throw new Error(`Agent call budget (${budget.maxAgentCalls}) exceeded.`);
    }

    const spec = node.config.tools.find((t) => t.name === agentName);
    if (!spec) {
      throw new Error(`Agent '${agentName}' not found in '${node.networkName}'.`);
    }

    this.emit("agent", {
      network: node.networkName,
      agent: agentName,
      depth: chain.length,
      slyDataRedacted: redactSlyData(slyData),
    });

    const linkSlots = new Set(Object.keys(node.config.link_slots || {}));
    const toolSchemas = this.buildToolSchemas(node, spec, linkSlots, isTopFront);
    const model =
      this.modelOverride ||
      spec.llm_config?.model_name ||
      node.config.llm_config?.model_name ||
      "gpt-4.1-mini";

    const messages: ChatMessage[] = [];
    if (spec.instructions) {
      messages.push({ role: "system", content: spec.instructions });
    }
    if (isTopFront && this.history.length > 0) {
      for (const h of this.history.slice(-6)) {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: "user", content: userText });

    const maxSteps = spec.max_steps || node.config.max_steps || 12;
    let lastRouter = node.llm.baseUrl;
    let lastModel = model;

    for (let step = 0; step < maxSteps; step++) {
      if (Date.now() > budget.deadline) {
        throw new Error("Execution deadline exceeded.");
      }

      const completion = await node.llm.complete({
        agentName,
        model,
        messages,
        tools: toolSchemas,
      });
      lastRouter = completion.routerUsed;
      lastModel = completion.modelUsed;

      if (!completion.toolCalls || completion.toolCalls.length === 0) {
        return {
          text: completion.content,
          routerUsed: lastRouter,
          modelUsed: lastModel,
        };
      }

      messages.push({
        role: "assistant",
        content: completion.content || "",
        tool_calls: completion.toolCalls,
      });

      for (const call of completion.toolCalls) {
        const resultStr = await this.dispatchToolCall(
          node,
          spec,
          call.function.name,
          call.function.arguments,
          slyData,
          chain,
          budget,
          linkSlots
        );
        messages.push({
          role: "tool",
          name: call.function.name,
          tool_call_id: call.id,
          content: resultStr,
        });
      }
    }

    throw new Error(`Agent '${agentName}' exceeded max_steps (${maxSteps}).`);
  }

  private buildToolSchemas(
    node: CompiledNode,
    spec: AgentSpec,
    linkSlots: Set<string>,
    isFront: boolean
  ): ToolSchema[] {
    const schemas: ToolSchema[] = [];

    for (const ref of spec.tools || []) {
      const kind = classifyTool(node.config, ref, linkSlots);
      if (kind === "agent" && typeof ref === "string") {
        const child = node.config.tools.find((t) => t.name === ref);
        if (child) {
          schemas.push({
            type: "function",
            function: {
              name: child.name,
              description: child.function?.description || `Delegate to ${child.name}`,
              parameters: (child.function?.parameters as Record<string, unknown>) || {
                type: "object",
                properties: { request: { type: "string" } },
                required: ["request"],
              },
            },
          });
        }
      } else if ((kind === "remote" || kind === "link") && typeof ref === "string") {
        const cleanName = kind === "link" ? ref : ref.split("/").filter(Boolean).pop() || "peer_agent";
        schemas.push({
          type: "function",
          function: {
            name: cleanName,
            description:
              node.config.link_slots?.[ref]?.description ||
              `Invoke external Open Agentic Web peer '${ref}' (requires explicit user consent).`,
            parameters: {
              type: "object",
              properties: {
                request: {
                  type: "string",
                  description: "Concise plain-language query (<140 chars recommended; no secrets).",
                },
              },
              required: ["request"],
            },
          },
        });
      }
    }

    // Expose site actions registered on this node to agents
    if (isFront || spec.name === "repo_auditor" || spec.name === "spec_conformance_auditor") {
      for (const action of this.actions.catalog({ base: node.base, network: node.networkName })) {
        schemas.push({
          type: "function",
          function: {
            name: `website_${action.name}`,
            description: `[Site Action (${action.effect})] ${action.description}`,
            parameters: action.inputSchema,
          },
        });
      }
    }

    return schemas;
  }

  private async dispatchToolCall(
    node: CompiledNode,
    callerSpec: AgentSpec,
    toolName: string,
    rawArgsJson: string,
    slyData: Record<string, unknown>,
    chain: string[],
    budget: CompositionBudget,
    linkSlots: Set<string>
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgsJson ? (JSON.parse(rawArgsJson) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ ok: false, error: "Invalid JSON tool arguments." });
    }

    this.emit("tool", {
      network: node.networkName,
      caller: callerSpec.name,
      tool: toolName,
      argsPreview: JSON.stringify(args).slice(0, 140),
    });

    if (toolName.startsWith("website_")) {
      const actionName = toolName.slice("website_".length);
      const requestId = `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      try {
        const receipt = await this.actions.invoke(
          { base: node.base, network: node.networkName },
          actionName,
          args,
          requestId,
          async (items) => {
            this.emit("action_confirm", { items });
            return this.onActionConfirm(items);
          }
        );
        return JSON.stringify(receipt);
      } catch (err) {
        return JSON.stringify({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Check internal agent
    const internal = node.config.tools.find((t) => t.name === toolName);
    if (internal) {
      const allowedKeys = callerSpec.allow?.to_downstream?.sly_data ?? [];
      const downstreamSly = filterSlyData(slyData, allowedKeys);
      const queryText =
        typeof args.request === "string"
          ? args.request
          : JSON.stringify(args);
      const res = await this.executeAgent(
        node,
        internal.name,
        queryText,
        downstreamSly,
        chain,
        budget,
        false
      );
      return res.text;
    }

    // Check link slot or external peer ref
    let targetRef: string | null = null;
    if (linkSlots.has(toolName)) {
      targetRef = this.getStoredLink(toolName);
      if (!targetRef && this.onLinkRequired) {
        targetRef = await this.onLinkRequired({
          reference: toolName,
          sourceNetwork: node.networkName,
          sourceOrigin: node.base,
        });
        if (targetRef) {
          targetRef = this.bindLocalLink(toolName, targetRef);
        }
      }
      if (!targetRef) {
        return `Link slot '${toolName}' is not bound to a peer URL yet. Bind a peer URL or select the built-in Peer Trust Verifier.`;
      }
    } else {
      for (const ref of callerSpec.tools || []) {
        if (typeof ref === "string" && ref.split("/").filter(Boolean).pop() === toolName) {
          targetRef = ref;
          break;
        }
      }
    }

    if (!targetRef) {
      return `Unknown tool '${toolName}'.`;
    }

    const requestText =
      typeof args.request === "string" ? args.request : JSON.stringify(args);
    return this.invokeRemotePeer(
      targetRef,
      requestText,
      slyData,
      callerSpec,
      node.manifest,
      chain,
      budget
    );
  }

  async invokeRemotePeer(
    targetRef: string,
    requestText: string,
    callerSlyData: Record<string, unknown>,
    callerSpec: AgentSpec | null,
    sourceManifest: AgentManifest,
    chain: string[],
    budget: CompositionBudget
  ): Promise<string> {
    const parsed = parsePeerTarget(targetRef, this.originUrl);

    if (!manifestAllowsPeer(parsed.url, sourceManifest, this.runtimeAllowedPeers)) {
      const errMsg = `Policy blocked peer origin '${parsed.origin}': not in allowed_peers.`;
      this.emit("error", { stage: "peer_policy", target: parsed.url, message: errMsg });
      return `Error from peer policy: ${errMsg}`;
    }

    const peerKey = `${parsed.siteBase}::${parsed.networkName}`;
    if (chain.includes(peerKey)) {
      const msg = `Composition cycle detected: ${[...chain, peerKey].join(" -> ")}`;
      this.emit("error", { stage: "cycle_detection", chain: [...chain, peerKey] });
      throw new Error(msg);
    }
    if (chain.length >= this.maxDepth) {
      const msg = `Composition depth limit (${this.maxDepth}) exceeded.`;
      this.emit("error", { stage: "depth_limit", depth: chain.length });
      throw new Error(msg);
    }

    budget.remoteCalls += 1;
    if (budget.remoteCalls > budget.maxRemoteCalls) {
      throw new Error(`Remote peer call budget (${budget.maxRemoteCalls}) exceeded.`);
    }
    const perPeer = (budget.peerCalls.get(peerKey) || 0) + 1;
    budget.peerCalls.set(peerKey, perPeer);
    if (perPeer > budget.maxCallsPerPeer) {
      throw new Error(`Per-peer call limit (${budget.maxCallsPerPeer}) exceeded for ${peerKey}.`);
    }

    const allowedKeys = callerSpec?.allow?.to_downstream?.sly_data ?? [];
    const forwardedSly = filterSlyData(callerSlyData, allowedKeys);
    this.emit("sly_data_boundary", {
      targetPeer: peerKey,
      callerKeys: Object.keys(callerSlyData),
      allowedKeys,
      forwardedKeys: Object.keys(forwardedSly),
    });

    if (this.consentDecisions.get(parsed.origin) !== "always" && this.onConsent) {
      const decision = await this.onConsent({
        peerOrigin: parsed.origin,
        peerUrl: parsed.url,
        networkName: parsed.networkName,
        purpose: `Load and execute peer network '${parsed.networkName}' inside your browser.`,
        requestPreview: requestText.slice(0, 140),
        allowedSlyKeys: Object.keys(forwardedSly),
      });
      this.emit("consent", {
        peerOrigin: parsed.origin,
        networkName: parsed.networkName,
        decision,
      });
      if (decision === "decline") {
        return `The user declined contacting ${parsed.origin} (${parsed.networkName}).`;
      }
      if (decision === "always") {
        this.consentDecisions.set(parsed.origin, "always");
      }
    }

    let peerNode = this.peerCache.get(peerKey);
    if (!peerNode) {
      const manifestUrl = `${parsed.siteBase}/agent-manifest.json`;
      this.emit("remote_fetch", { manifestUrl, requestedNetwork: parsed.networkName });
      const resp = await this.fetchImpl(manifestUrl, { cache: "no-store", credentials: "omit" });
      if (!resp.ok) {
        throw new Error(`Peer manifest fetch failed (${resp.status}) at ${manifestUrl}`);
      }
      const peerManifest = (await resp.json()) as AgentManifest;
      const manifestCheck = validateManifest(peerManifest);
      if (!manifestCheck.valid) {
        throw new Error(`Invalid peer manifest at ${parsed.origin}: ${manifestCheck.errors.join("; ")}`);
      }
      // Fail closed: exact network name match required (Spec 3.2 step 5)
      const entry = peerManifest.networks.find((n) => n.name === parsed.networkName);
      if (!entry) {
        throw new Error(
          `No published network named '${parsed.networkName}' at ${parsed.origin}; failing closed.`
        );
      }

      const netUrl = this.resolveUrl(parsed.siteBase, entry.hocon);
      const netResp = await this.fetchImpl(netUrl, { cache: "no-store", credentials: "omit" });
      if (!netResp.ok) {
        throw new Error(`Peer network fetch failed (${netResp.status}) at ${netUrl}`);
      }
      const rawNet = (await netResp.json()) as NetworkConfig;
      const config = filterConfig(rawNet);
      const netCheck = validateNetwork(config);
      if (!netCheck.valid || !netCheck.frontMan) {
        throw new Error(`Peer network '${entry.name}' invalid: ${netCheck.errors.join("; ")}`);
      }

      // Spec 4: Peer MUST inherit caller's active router; peer manifest CANNOT replace router or receive user key.
      const callerRouter = selectPeerRouter(this.userRouter!);
      const peerLlm = new LlmClient({
        baseUrl: callerRouter.baseUrl,
        apiKey: callerRouter.publisherFunded ? "" : this.byokKey,
        mock: callerRouter.mock,
        publisherFunded: callerRouter.publisherFunded,
        fetchImpl: this.fetchImpl,
      });

      peerNode = {
        networkName: entry.name,
        frontMan: netCheck.frontMan,
        config,
        manifest: peerManifest,
        base: parsed.siteBase,
        llm: peerLlm,
        links: await this.loadPublishedLinks(parsed.siteBase, entry.name),
      };
      this.peerCache.set(peerKey, peerNode);
    }

    this.emit("remote_call", {
      peerOrigin: parsed.origin,
      network: peerNode.networkName,
      callerRouterUsed: peerNode.llm.baseUrl,
      peerManifestDeclaredRouterIgnored: peerNode.manifest.llm_router?.base_url || null,
      slyDataRedacted: redactSlyData(forwardedSly),
    });

    const nextChain = [...chain, peerKey];
    const result = await this.executeAgent(
      peerNode,
      peerNode.frontMan,
      requestText,
      forwardedSly,
      nextChain,
      budget,
      false
    );
    return result.text;
  }
}
