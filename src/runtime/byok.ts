import type { AgentManifest } from "./spec";

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  requiresKey: boolean;
  notes: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "mock",
    label: "Deterministic Browser Mock (No Key)",
    baseUrl: "browser://mock",
    defaultModel: "openscout-mock-v1",
    requiresKey: false,
    notes: "Runs full multi-agent orchestration, site actions, and peer consent locally without network calls."
  },
  {
    id: "openai",
    label: "OpenAI (Direct Browser CORS)",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    requiresKey: true,
    notes: "Calls OpenAI Chat Completions directly from the browser using your own API key."
  },
  {
    id: "gemini",
    label: "Google Gemini (OpenAI-Compat CORS)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    requiresKey: true,
    notes: "Calls Gemini's OpenAI-compatible endpoint directly from the browser."
  },
  {
    id: "openrouter",
    label: "OpenRouter (Direct Browser CORS)",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemma-4-31b-it:free",
    requiresKey: true,
    notes: "Routes requests through OpenRouter directly from the browser."
  },
  {
    id: "ollama",
    label: "Ollama Local (127.0.0.1)",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "gemma4:e4b",
    requiresKey: false,
    notes: "Calls a local Ollama OpenAI-compatible endpoint."
  }
];

export interface ByokProfile {
  id: string;
  name: string;
  router: string;
  model: string;
  key: string;
  updatedAt: string;
}

export interface ByokStore {
  version: number;
  selectedId: string;
  updatedAt: string;
  profiles: ByokProfile[];
}

export interface ActiveRouterSelection {
  baseUrl: string;
  mock: boolean;
  publisherFunded: boolean;
  upgradedToByok: boolean;
  requiresKey: boolean;
}

const STORE_KEY = "openscout-byok-profiles-v1";
const COOKIE_NAME = "openscout_byok_profiles_v1";
const TAB_KEY_ITEM = "openscout-byok-tab-key";
const TAB_ROUTER_ITEM = "openscout-byok-tab-router";
const TAB_MODEL_ITEM = "openscout-byok-tab-model";
const VERSION = 1;
const MAX_PROFILES = 12;

export function normalizeModelName(model: unknown): string {
  const s = String(model ?? "").trim();
  if (s === '""' || s === "''") return "";
  return s;
}

export function canUseByokCookie(): boolean {
  if (typeof location === "undefined") return false;
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function emptyStore(): ByokStore {
  return { version: VERSION, selectedId: "", updatedAt: "", profiles: [] };
}

function normalizeProfile(raw: unknown): ByokProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = String(obj.id || "").trim() || newProfileId();
  const router = String(obj.router || "").trim();
  const model = normalizeModelName(obj.model);
  const key = String(obj.key || "");
  if (!router && !model && !key) return null;
  return {
    id,
    name: String(obj.name || guessProfileName(router, model)).slice(0, 80),
    router,
    model,
    key,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
  };
}

function normalizeStore(raw: unknown): ByokStore | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const profiles = (Array.isArray(obj.profiles) ? obj.profiles : [])
    .map(normalizeProfile)
    .filter((p): p is ByokProfile => Boolean(p))
    .slice(0, MAX_PROFILES);
  const selectedId = profiles.some((p) => p.id === obj.selectedId)
    ? String(obj.selectedId)
    : "";
  return {
    version: VERSION,
    selectedId,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
    profiles,
  };
}

export function guessProfileName(router: string, model: string): string {
  const hay = `${router} ${model}`.toLowerCase();
  if (hay.includes("browser://mock")) return "Offline Mock";
  if (hay.includes("generativelanguage.googleapis.com") || hay.includes("gemini")) return "Google Gemini";
  if (hay.includes("openrouter")) return "OpenRouter";
  if (hay.includes("openai") || hay.includes("gpt-")) return "OpenAI";
  if (hay.includes("127.0.0.1") || hay.includes("localhost") || hay.includes("ollama")) return "Local LLM";
  return model || "Custom Router";
}

function newProfileId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function loadByokStore(): ByokStore {
  let local: ByokStore | null = null;
  try {
    if (typeof localStorage !== "undefined") {
      local = normalizeStore(JSON.parse(localStorage.getItem(STORE_KEY) || "null"));
    }
  } catch {
    local = null;
  }

  let cookie: ByokStore | null = null;
  if (canUseByokCookie() && typeof document !== "undefined") {
    const prefix = `${COOKIE_NAME}=`;
    const part = document.cookie.split("; ").find((c) => c.startsWith(prefix));
    if (part) {
      try {
        cookie = normalizeStore(JSON.parse(decodeURIComponent(part.slice(prefix.length))));
      } catch {
        cookie = null;
      }
    }
  }

  if (!local) return cookie || emptyStore();
  if (!cookie) return local;
  return cookie.updatedAt > local.updatedAt ? cookie : local;
}

export function saveByokStore(store: ByokStore): ByokStore {
  const normalized = normalizeStore(store) || emptyStore();
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORE_KEY, JSON.stringify(normalized));
    }
  } catch {
    // ignore storage quota failures
  }
  if (canUseByokCookie() && typeof document !== "undefined") {
    const encoded = encodeURIComponent(JSON.stringify(normalized));
    const attrs = `Path=/; Max-Age=${60 * 60 * 24 * 180}; SameSite=Lax${
      location.protocol === "https:" ? "; Secure" : ""
    }`;
    if (encoded.length <= 3800) {
      document.cookie = `${COOKIE_NAME}=${encoded}; ${attrs}`;
    }
  }
  return normalized;
}

export function upsertByokProfile(
  profile: Partial<ByokProfile>,
  { select = true } = {}
): { store: ByokStore; profile: ByokProfile | null } {
  const store = loadByokStore();
  const now = new Date().toISOString();
  const id = profile.id || newProfileId();
  const existing = store.profiles.find((p) => p.id === id) || {};
  const next = normalizeProfile({ ...existing, ...profile, id, updatedAt: now });
  if (!next) return { store, profile: null };
  const profiles = [next, ...store.profiles.filter((p) => p.id !== id)].slice(0, MAX_PROFILES);
  const nextStore = saveByokStore({
    version: VERSION,
    selectedId: select ? id : store.selectedId,
    updatedAt: now,
    profiles,
  });
  return { store: nextStore, profile: next };
}

export function deleteByokProfile(id: string): ByokStore {
  const store = loadByokStore();
  const profiles = store.profiles.filter((p) => p.id !== id);
  const selectedId = store.selectedId === id ? profiles[0]?.id || "" : store.selectedId;
  return saveByokStore({
    version: VERSION,
    selectedId,
    updatedAt: new Date().toISOString(),
    profiles,
  });
}

export function clearAllByokProfiles(): ByokStore {
  const empty = emptyStore();
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORE_KEY);
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(TAB_KEY_ITEM);
      sessionStorage.removeItem(TAB_ROUTER_ITEM);
      sessionStorage.removeItem(TAB_MODEL_ITEM);
    }
    if (canUseByokCookie() && typeof document !== "undefined") {
      document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
    }
  } catch {
    // ignore
  }
  return empty;
}

export function saveTabByokSetup(setup: { router: string; model: string; key: string } | null): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (!setup) {
      sessionStorage.removeItem(TAB_KEY_ITEM);
      sessionStorage.removeItem(TAB_ROUTER_ITEM);
      sessionStorage.removeItem(TAB_MODEL_ITEM);
      return;
    }
    sessionStorage.setItem(TAB_KEY_ITEM, setup.key || "");
    sessionStorage.setItem(TAB_MODEL_ITEM, setup.model || "");
    sessionStorage.setItem(TAB_ROUTER_ITEM, setup.router || "");
  } catch {
    // ignore
  }
}

export function loadTabByokSetup(): { router: string; model: string; key: string } {
  try {
    if (typeof sessionStorage !== "undefined") {
      const router = sessionStorage.getItem(TAB_ROUTER_ITEM);
      if (router !== null) {
        return {
          router,
          model: sessionStorage.getItem(TAB_MODEL_ITEM) || "",
          key: sessionStorage.getItem(TAB_KEY_ITEM) || "",
        };
      }
    }
  } catch {
    // ignore
  }
  const store = loadByokStore();
  const selected = store.profiles.find((p) => p.id === store.selectedId) || null;
  return {
    router: selected?.router || "",
    model: selected?.model || "",
    key: selected?.key || "",
  };
}

export function routerRequiresKey(baseUrl: string): boolean {
  const clean = String(baseUrl || "").trim().toLowerCase();
  if (!clean || clean === "browser://mock") return false;
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?\b/.test(clean)) return false;
  return true;
}

function sameRouter(left: string, right: string): boolean {
  return String(left || "").trim().replace(/\/$/, "") === String(right || "").trim().replace(/\/$/, "");
}

export function selectTopRouter(
  manifest: AgentManifest,
  routerOverride = "",
  byokKey = "",
  modelOverride = ""
): ActiveRouterSelection {
  const declared = manifest?.llm_router;
  const declaredBase = declared?.base_url || "browser://mock";
  const isDeclaredMock = declared?.mock === true || declaredBase === "browser://mock";
  const publisherFunded = declared?.publisher_funded === true && !isDeclaredMock;
  const hasRealKey = Boolean(byokKey && byokKey !== "demo");
  const hasExplicitModel = Boolean(normalizeModelName(modelOverride));
  const requested = String(routerOverride || "").trim().replace(/\/$/, "");
  const requestedMock = Boolean(requested && (requested === "browser://mock" || (isDeclaredMock && sameRouter(requested, declaredBase))));
  const requestedPublisherFunded = Boolean(requested && publisherFunded && sameRouter(requested, declaredBase));

  if ((hasRealKey || hasExplicitModel) && (!requested || requestedMock || requestedPublisherFunded)) {
    if (requestedMock && !hasRealKey) {
      return {
        baseUrl: "browser://mock",
        mock: true,
        publisherFunded: false,
        upgradedToByok: false,
        requiresKey: false,
      };
    }
    if (!declared?.byok_router) {
      throw new Error("A BYOK key is configured, but this site declares no BYOK router route.");
    }
    return {
      baseUrl: declared.byok_router.replace(/\/$/, ""),
      mock: false,
      publisherFunded: false,
      upgradedToByok: true,
      requiresKey: routerRequiresKey(declared.byok_router),
    };
  }

  if (requested) {
    const mock = requested === "browser://mock" || (isDeclaredMock && sameRouter(requested, declaredBase));
    return {
      baseUrl: requested,
      mock,
      publisherFunded: requestedPublisherFunded,
      upgradedToByok: false,
      requiresKey: !mock && !requestedPublisherFunded && routerRequiresKey(requested),
    };
  }

  return {
    baseUrl: declaredBase.replace(/\/$/, ""),
    mock: isDeclaredMock,
    publisherFunded,
    upgradedToByok: false,
    requiresKey: !isDeclaredMock && !publisherFunded && routerRequiresKey(declaredBase),
  };
}

export function selectPeerRouter(callerRouter: ActiveRouterSelection): ActiveRouterSelection {
  if (!callerRouter?.baseUrl) {
    throw new Error("The caller has no active LLM router to run this peer network.");
  }
  return {
    baseUrl: callerRouter.baseUrl,
    mock: callerRouter.mock,
    publisherFunded: callerRouter.publisherFunded,
    upgradedToByok: false,
    requiresKey: callerRouter.requiresKey,
  };
}

export function redactSecretFromString(input: string, secret: string): string {
  if (!secret || secret.length < 4) return input;
  return input.split(secret).join("<redacted-byok-key>");
}
