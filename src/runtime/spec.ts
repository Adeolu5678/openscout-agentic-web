export interface NetworkEntry {
  name: string;
  front_man: string;
  hocon: string;
  description?: string;
  tags?: string[];
  sample_queries?: string[];
}

export interface LlmRouterConfig {
  base_url: string;
  mock?: boolean;
  publisher_funded?: boolean;
  byok_router?: string;
}

export interface PeerPolicyConfig {
  mode: "closed" | "open";
  deny_origins?: string[];
  denied_origins?: string[];
  note?: string;
}

export interface LinkingExport {
  network: string;
  front_man?: string;
  aliases?: string[];
  url: string;
}

export interface LinkingImport {
  reference: string;
  description?: string;
}

export interface ActionsManifestConfig {
  version: number;
  module: string;
  bridge?: string;
  agentTools?: string[];
}

export interface AgentManifest {
  brand?: string;
  networks: NetworkEntry[];
  llm_router?: LlmRouterConfig;
  allowed_peers?: string[];
  peer_policy?: PeerPolicyConfig;
  web_policy?: PeerPolicyConfig;
  agent_mcp?: {
    protocol: string;
    network: string;
    front_man: string;
    available: boolean;
    reason?: string;
  };
  theme?: { primary?: string };
  linking?: {
    protocol?: string;
    exports?: LinkingExport[];
    imports?: LinkingImport[];
    link_updates?: { mode?: string };
  };
  deployment?: {
    mode?: string;
    self_contained_runtime?: boolean;
    browser_mock?: boolean;
    direct_byok?: boolean;
    direct_mcp_requires_cors?: boolean;
    public_mcp_facade?: boolean;
  };
  actions?: ActionsManifestConfig;
  coded_tools?: {
    bundle?: string;
    integrity?: string;
  };
}

export interface AgentFunctionSchema {
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface SlyDataAllowRules {
  to_downstream?: { sly_data?: string[] };
  to_upstream?: { sly_data?: string[] };
}

export interface AgentSpec {
  name: string;
  function?: AgentFunctionSchema;
  instructions?: string;
  tools?: Array<string | { url: string; tools?: string[] }>;
  allow?: SlyDataAllowRules;
  llm_config?: { model_name?: string; [key: string]: unknown };
  max_steps?: number;
  class?: string;
  toolbox?: string;
}

export interface NetworkConfig {
  metadata?: {
    description?: string;
    sample_queries?: string[];
  };
  llm_config?: { model_name?: string; [key: string]: unknown };
  max_steps?: number;
  link_slots?: Record<string, { description?: string }>;
  link_labels?: Record<string, string>;
  links?: Record<string, string>;
  commondefs?: {
    replacement_strings?: Record<string, string>;
    replacement_values?: Record<string, unknown>;
  };
  tools: AgentSpec[];
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface NetworkValidationResult {
  valid: boolean;
  frontMan: string | null;
  errors: string[];
  warnings: string[];
  externals: string[];
  mcps: string[];
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function deepClone<T>(v: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(v)
    : (JSON.parse(JSON.stringify(v)) as T);
}

export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = deepClone(base);
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = deepClone(v);
    }
  }
  return out;
}

export function isExternalAgent(ref: unknown): ref is string {
  if (typeof ref !== "string") return false;
  return /^https?:\/\//i.test(ref) || ref.startsWith("/");
}

export function isMcpRef(ref: unknown): boolean {
  if (isPlainObject(ref)) return true;
  if (typeof ref !== "string") return false;
  if (!/^https?:\/\//i.test(ref)) return false;
  const lowered = ref.toLowerCase();
  return (
    lowered.includes("/mcp/") ||
    lowered.endsWith("/mcp") ||
    lowered.includes("//mcp.") ||
    lowered.includes(".mcp.")
  );
}

export function findFrontMan(config: NetworkConfig): string | null {
  const tools = Array.isArray(config?.tools) ? config.tools : null;
  if (!tools || tools.length === 0) return null;
  for (const agent of tools) {
    if (agent?.instructions && !agent.class && !agent.toolbox) {
      return agent.name || null;
    }
  }
  return tools[0]?.name || null;
}

export function agentNames(config: NetworkConfig): string[] {
  if (!Array.isArray(config?.tools)) return [];
  return config.tools
    .map((a) => a?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

export type ToolKind = "mcp" | "remote" | "missing" | "coded" | "toolbox" | "agent" | "link";

export function classifyTool(
  config: NetworkConfig,
  ref: unknown,
  linkSlots: Set<string> = new Set(Object.keys(config?.link_slots || {}))
): ToolKind {
  if (typeof ref !== "string" || isMcpRef(ref)) return "mcp";
  const names = agentNames(config);
  if (isExternalAgent(ref) && !names.includes(ref)) return "remote";
  const spec = (config.tools || []).find((a) => a?.name === ref) || null;
  if (!spec) {
    return linkSlots.has(ref) ? "link" : "missing";
  }
  if (spec.class) return "coded";
  if (spec.toolbox) return "toolbox";
  return "agent";
}

const DEFAULT_KEYS: Array<keyof NetworkConfig & keyof AgentSpec> = [
  "llm_config",
  "max_steps",
];

function walkReplace(
  value: unknown,
  fn: (val: unknown) => unknown
): unknown {
  if (Array.isArray(value)) return value.map((item) => walkReplace(item, fn));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walkReplace(v, fn);
    }
    return out;
  }
  return fn(value);
}

export function filterConfig(rawConfig: NetworkConfig): NetworkConfig {
  let config = deepClone(rawConfig);
  const strs = config.commondefs?.replacement_strings || {};
  const vals = config.commondefs?.replacement_values || {};

  config = walkReplace(config, (v) => {
    if (typeof v === "string") {
      if (Object.prototype.hasOwnProperty.call(vals, v)) {
        return vals[v];
      }
      return v.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(strs, key) ? strs[key] : match
      );
    }
    return v;
  }) as NetworkConfig;

  const tools = Array.isArray(config.tools) ? config.tools : [];
  for (const agent of tools) {
    for (const key of DEFAULT_KEYS) {
      const topVal = config[key];
      const agentVal = agent[key];
      if (topVal !== undefined) {
        if (isPlainObject(topVal) && isPlainObject(agentVal)) {
          (agent as unknown as Record<string, unknown>)[key] = deepMerge(topVal, agentVal);
        } else if (agentVal === undefined) {
          (agent as unknown as Record<string, unknown>)[key] = deepClone(topVal);
        }
      }
    }
    if (typeof agent.name === "string") {
      agent.name = agent.name.trim();
    }
  }
  return config;
}

export function validateNetwork(rawConfig: NetworkConfig): NetworkValidationResult {
  const config = filterConfig(rawConfig);
  const errors: string[] = [];
  const warnings: string[] = [];
  const externals: string[] = [];
  const mcps: string[] = [];

  if (!Array.isArray(config.tools)) {
    errors.push("Network must have a 'tools' array.");
    return { valid: false, frontMan: null, errors, warnings, externals, mcps };
  }
  if (config.tools.length === 0) {
    errors.push("Network 'tools' array must not be empty.");
    return { valid: false, frontMan: null, errors, warnings, externals, mcps };
  }

  const seen = new Set<string>();
  for (const agent of config.tools) {
    if (!agent?.name || typeof agent.name !== "string") {
      errors.push("Every agent must have a non-empty 'name'.");
      continue;
    }
    if (seen.has(agent.name)) {
      errors.push(`Duplicate agent name '${agent.name}'.`);
    }
    seen.add(agent.name);
    if (!agent.function?.description) {
      warnings.push(`Agent '${agent.name}' is missing function.description.`);
    }
  }

  const frontMan = findFrontMan(config);
  if (!frontMan) {
    errors.push("No front-man agent found.");
  }

  const linkSlots = new Set(Object.keys(config.link_slots || {}));
  for (const agent of config.tools) {
    for (const ref of agent.tools || []) {
      const kind = classifyTool(config, ref, linkSlots);
      if (kind === "missing") {
        errors.push(`Agent '${agent.name}' references missing tool '${String(ref)}'.`);
      } else if (kind === "remote" && typeof ref === "string") {
        externals.push(ref);
      } else if (kind === "mcp") {
        mcps.push(typeof ref === "string" ? ref : ref.url);
      }
    }
  }

  return {
    valid: errors.length === 0,
    frontMan,
    errors,
    warnings,
    externals,
    mcps,
  };
}

export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ["Manifest root must be a JSON object."], warnings };
  }

  const networks = manifest.networks;
  if (!Array.isArray(networks) || networks.length === 0) {
    errors.push("Manifest must declare a non-empty 'networks' array.");
  } else {
    const names = new Set<string>();
    for (const [idx, entry] of networks.entries()) {
      if (!isPlainObject(entry)) {
        errors.push(`networks[${idx}] must be an object.`);
        continue;
      }
      if (typeof entry.name !== "string" || !entry.name.trim()) {
        errors.push(`networks[${idx}] is missing required 'name'.`);
      } else if (names.has(entry.name)) {
        errors.push(`Duplicate network name '${entry.name}' in manifest.`);
      } else {
        names.add(entry.name);
      }
      if (typeof entry.front_man !== "string" || !entry.front_man.trim()) {
        errors.push(`networks[${idx}] is missing required 'front_man'.`);
      }
      if (typeof entry.hocon !== "string" || !entry.hocon.trim()) {
        errors.push(`networks[${idx}] is missing required 'hocon' path or URL.`);
      }
    }
  }

  if (manifest.llm_router !== undefined) {
    if (!isPlainObject(manifest.llm_router) || typeof manifest.llm_router.base_url !== "string" || !manifest.llm_router.base_url.trim()) {
      errors.push("Manifest 'llm_router' must include a non-empty 'base_url'.");
    }
  } else {
    warnings.push("Manifest omits 'llm_router'; caller must supply a BYOK router.");
  }

  const policy = manifest.peer_policy ?? manifest.web_policy;
  if (policy !== undefined) {
    if (!isPlainObject(policy) || !["closed", "open"].includes(String(policy.mode))) {
      errors.push("Manifest 'peer_policy.mode' must be 'closed' or 'open'.");
    }
  } else {
    warnings.push("Manifest omits 'peer_policy'; defaulting to closed allowed_peers check.");
  }

  if (manifest.allowed_peers !== undefined && !Array.isArray(manifest.allowed_peers)) {
    errors.push("Manifest 'allowed_peers' must be an array of origin URLs.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function normOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || "").trim().replace(/\/$/, "");
  }
}

export function manifestAllowsPeer(
  target: string,
  manifest: AgentManifest | null | undefined,
  runtimeAllowedPeers: Set<string> = new Set()
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;

  const targetOrigin = parsed.origin;
  const policy = manifest?.peer_policy ?? manifest?.web_policy;
  const denied = (policy?.deny_origins ?? policy?.denied_origins ?? []).map(normOrigin);
  if (denied.includes(targetOrigin)) return false;

  if (policy?.mode === "open") {
    return true;
  }

  const declared = (manifest?.allowed_peers || []).map(normOrigin);
  return declared.includes(targetOrigin) || runtimeAllowedPeers.has(targetOrigin);
}

export function parsePeerTarget(
  ref: string,
  baseOrigin?: string
): { siteBase: string; networkName: string; origin: string; url: string } {
  const resolved = new URL(ref, baseOrigin ? `${baseOrigin.replace(/\/$/, "")}/` : undefined);
  if (!["http:", "https:"].includes(resolved.protocol)) {
    throw new Error(`Peer URL must use http or https: ${ref}`);
  }
  const segments = resolved.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`Peer URL must end with the published network name: ${ref}`);
  }
  const networkName = decodeURIComponent(segments[segments.length - 1]);
  const siteBase = new URL("./", resolved).href.replace(/\/$/, "");
  return {
    siteBase,
    networkName,
    origin: resolved.origin,
    url: resolved.href,
  };
}

export function redactSlyData(slyData: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!slyData) return slyData;
  const out: Record<string, string> = {};
  for (const key of Object.keys(slyData)) {
    out[key] = "<redacted>";
  }
  return out;
}

export function filterSlyData(
  slyData: Record<string, unknown> | undefined,
  allowedKeys: string[] | null | undefined
): Record<string, unknown> {
  if (!slyData || !allowedKeys || allowedKeys.length === 0) return {};
  if (allowedKeys.includes("*")) return deepClone(slyData);
  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(slyData, key)) {
      out[key] = deepClone(slyData[key]);
    }
  }
  return out;
}
