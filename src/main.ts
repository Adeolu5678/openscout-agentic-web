import "./styles.css";
import type { ActionConfirmationItem } from "./runtime/actions";
import {
  clearAllByokProfiles,
  loadByokStore,
  loadTabByokSetup,
  PROVIDER_PRESETS,
  saveTabByokSetup,
  upsertByokProfile,
} from "./runtime/byok";
import {
  OpenAgenticEngine,
  type ConsentDecision,
  type ConsentRequest,
  type TraceEvent,
} from "./runtime/engine";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el as T;
};

const statusConformance = $<HTMLSpanElement>("status-conformance");
const statusRouter = $<HTMLSpanElement>("status-router");
const byokBadge = $<HTMLSpanElement>("byok-badge");
const chatFeed = $<HTMLDivElement>("chat-feed");
const sampleBar = $<HTMLDivElement>("sample-queries");
const chatForm = $<HTMLFormElement>("chat-form");
const chatInput = $<HTMLTextAreaElement>("chat-input");
const btnSend = $<HTMLButtonElement>("btn-send");
const btnResetChat = $<HTMLButtonElement>("btn-reset-chat");

const byokForm = $<HTMLFormElement>("byok-form");
const byokPreset = $<HTMLSelectElement>("byok-preset");
const byokRouter = $<HTMLInputElement>("byok-router");
const byokModel = $<HTMLInputElement>("byok-model");
const byokKey = $<HTMLInputElement>("byok-key");
const byokNote = $<HTMLParagraphElement>("byok-note");
const byokProfiles = $<HTMLDivElement>("byok-profiles");
const btnClearByok = $<HTMLButtonElement>("btn-clear-byok");

const peerForm = $<HTMLFormElement>("peer-form");
const peerUrlInput = $<HTMLInputElement>("peer-url");
const peerQueryInput = $<HTMLInputElement>("peer-query");
const peerSlyInput = $<HTMLInputElement>("peer-sly");

const traceList = $<HTMLDivElement>("trace-list");
const btnClearTrace = $<HTMLButtonElement>("btn-clear-trace");
const dossierList = $<HTMLDivElement>("dossier-list");

const consentDialog = $<HTMLDialogElement>("consent-dialog");
const consentOrigin = $<HTMLElement>("consent-origin");
const consentNetwork = $<HTMLElement>("consent-network");
const consentPreview = $<HTMLElement>("consent-preview");
const consentSly = $<HTMLElement>("consent-sly");
const consentDecline = $<HTMLButtonElement>("consent-decline");
const consentAllow = $<HTMLButtonElement>("consent-allow");
const consentAlways = $<HTMLButtonElement>("consent-always");

const confirmDialog = $<HTMLDialogElement>("confirm-dialog");
const confirmPayload = $<HTMLPreElement>("confirm-payload");
const confirmCancel = $<HTMLButtonElement>("confirm-cancel");
const confirmApprove = $<HTMLButtonElement>("confirm-approve");

function askUserConsent(req: ConsentRequest): Promise<ConsentDecision> {
  return new Promise((resolve) => {
    consentOrigin.textContent = req.peerOrigin;
    consentNetwork.textContent = req.networkName;
    consentPreview.textContent = req.requestPreview;
    consentSly.textContent = req.allowedSlyKeys.length
      ? req.allowedSlyKeys.join(", ")
      : "None (deny-by-default enforced)";

    const finish = (decision: ConsentDecision) => {
      consentDecline.onclick = null;
      consentAllow.onclick = null;
      consentAlways.onclick = null;
      consentDialog.close();
      resolve(decision);
    };

    consentDecline.onclick = () => finish("decline");
    consentAllow.onclick = () => finish("allow");
    consentAlways.onclick = () => finish("always");
    consentDialog.showModal();
  });
}

function askActionConfirm(items: ActionConfirmationItem[]): Promise<boolean> {
  return new Promise((resolve) => {
    confirmPayload.textContent = JSON.stringify(items, null, 2);
    const finish = (approved: boolean) => {
      confirmCancel.onclick = null;
      confirmApprove.onclick = null;
      confirmDialog.close();
      resolve(approved);
    };
    confirmCancel.onclick = () => finish(false);
    confirmApprove.onclick = () => finish(true);
    confirmDialog.showModal();
  });
}

function appendMessage(role: "user" | "assistant" | "system", text: string, meta = ""): void {
  const box = document.createElement("div");
  box.className = `msg msg-${role}`;
  if (meta) {
    const m = document.createElement("div");
    m.className = "msg-meta";
    m.textContent = meta;
    box.appendChild(m);
  }
  const body = document.createElement("div");
  body.textContent = text;
  box.appendChild(body);
  chatFeed.appendChild(box);
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function renderTraceEvent(ev: TraceEvent): void {
  const row = document.createElement("div");
  row.className = "trace-item";
  const head = document.createElement("div");
  head.className = "trace-item-head";
  head.innerHTML = `<strong>${ev.kind}</strong><span>${ev.timestamp.slice(11, 19)}</span>`;
  const body = document.createElement("code");
  body.textContent = JSON.stringify(ev.detail);
  row.append(head, body);
  traceList.prepend(row);
}

function renderDossiers(): void {
  dossierList.innerHTML = "";
  let list: Array<{ id: string; target: string; verdict: string; savedAt: string }> = [];
  try {
    const raw = localStorage.getItem("openscout-audit-dossiers-v1");
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    list = [];
  }
  if (!list.length) {
    dossierList.textContent = "No saved dossiers yet.";
    return;
  }
  for (const item of list.slice(0, 6)) {
    const el = document.createElement("div");
    el.className = "dossier-item";
    el.textContent = `${item.id} | ${item.verdict} | ${item.target} (${item.savedAt.slice(0, 16)})`;
    dossierList.appendChild(el);
  }
}

const initialSetup = loadTabByokSetup();
const engine = new OpenAgenticEngine({
  originUrl: location.origin,
  routerOverride: initialSetup.router,
  modelOverride: initialSetup.model,
  byokKey: initialSetup.key,
  onConsent: askUserConsent,
  onActionConfirm: askActionConfirm,
  onTrace: renderTraceEvent,
});

function refreshRouterBadges(): void {
  const info = engine.getActiveRouterInfo();
  if (!info) return;
  statusRouter.textContent = `Router: ${info.baseUrl}`;
  if (info.mock) {
    byokBadge.textContent = "Mock Mode";
    byokBadge.className = "badge badge-neutral";
  } else {
    byokBadge.textContent = "Live BYOK";
    byokBadge.className = "badge badge-pass";
  }
}

function renderByokProfiles(): void {
  const store = loadByokStore();
  byokProfiles.innerHTML = "";
  for (const p of store.profiles) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-btn";
    btn.textContent = `${p.name} (${p.model || "default"})`;
    btn.onclick = () => {
      byokRouter.value = p.router;
      byokModel.value = p.model;
      byokKey.value = p.key;
      saveTabByokSetup({ router: p.router, model: p.model, key: p.key });
      engine.updateInferenceConfig({ routerOverride: p.router, modelOverride: p.model, byokKey: p.key });
      refreshRouterBadges();
      appendMessage("system", `Switched active tab inference profile to ${p.name} (${p.router}).`);
    };
    byokProfiles.appendChild(btn);
  }
}

function initByokControls(): void {
  for (const preset of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.label;
    byokPreset.appendChild(opt);
  }
  const activeRouter = initialSetup.router || "browser://mock";
  const matchedPreset = PROVIDER_PRESETS.find((p) => p.baseUrl === activeRouter) || PROVIDER_PRESETS[0];
  byokPreset.value = matchedPreset.id;
  byokRouter.value = initialSetup.router || matchedPreset.baseUrl;
  byokModel.value = initialSetup.model || matchedPreset.defaultModel;
  byokKey.value = initialSetup.key || "";
  byokNote.textContent = matchedPreset.notes;

  byokPreset.onchange = () => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === byokPreset.value) || PROVIDER_PRESETS[0];
    byokRouter.value = preset.baseUrl;
    byokModel.value = preset.defaultModel;
    byokNote.textContent = preset.notes;
  };

  byokForm.onsubmit = (e) => {
    e.preventDefault();
    const router = byokRouter.value.trim() || "browser://mock";
    const model = byokModel.value.trim();
    const key = byokKey.value.trim();
    saveTabByokSetup({ router, model, key });
    upsertByokProfile({ router, model, key });
    engine.updateInferenceConfig({ routerOverride: router, modelOverride: model, byokKey: key });
    refreshRouterBadges();
    renderByokProfiles();
    appendMessage("system", `Inference settings updated -> ${router} (model: ${model || "network default"}).`);
  };

  btnClearByok.onclick = () => {
    clearAllByokProfiles();
    byokPreset.value = "mock";
    byokRouter.value = "browser://mock";
    byokModel.value = "openscout-mock-v1";
    byokKey.value = "";
    engine.updateInferenceConfig({ routerOverride: "browser://mock", modelOverride: "", byokKey: "" });
    refreshRouterBadges();
    renderByokProfiles();
    appendMessage("system", "Cleared all stored BYOK profiles and reverted to Deterministic Browser Mock.");
  };
}

async function boot(): Promise<void> {
  initByokControls();
  renderByokProfiles();
  renderDossiers();
  peerUrlInput.value = `${location.origin}/peers/trust_verifier`;

  document.querySelectorAll<HTMLButtonElement>("[data-peer-local]").forEach((btn) => {
    btn.onclick = () => {
      peerUrlInput.value = `${location.origin}/peers/trust_verifier`;
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-peer-url]").forEach((btn) => {
    btn.onclick = () => {
      peerUrlInput.value = btn.dataset.peerUrl || "";
    };
  });

  try {
    const { manifest, frontMan } = await engine.loadTop();
    statusConformance.textContent = `MVP 0.3 Valid (${frontMan})`;
    statusConformance.className = "badge badge-pass";
    refreshRouterBadges();

    const samples = manifest.networks[0]?.sample_queries || [];
    for (const q of samples) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip-btn";
      btn.textContent = q;
      btn.onclick = () => {
        chatInput.value = q;
        chatForm.requestSubmit();
      };
      sampleBar.appendChild(btn);
    }

    appendMessage(
      "system",
      `Loaded '${manifest.networks[0].name}' (front_man: ${frontMan}). Choose a sample query or enter any GitHub repo / agentic site URL.`
    );
  } catch (err) {
    statusConformance.textContent = "Manifest Error";
    statusConformance.className = "badge badge-err";
    appendMessage("system", `Boot error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

chatForm.onsubmit = async (e) => {
  e.preventDefault();
  const prompt = chatInput.value.trim();
  if (!prompt) return;
  chatInput.value = "";
  appendMessage("user", prompt);
  btnSend.disabled = true;

  try {
    const res = await engine.runTurn(prompt, {
      slyData: { caller_audit_id: "openscout-session", internal_secret: "local-only" },
    });
    appendMessage("assistant", res.text, `router=${res.routerUsed} | model=${res.modelUsed}`);
    renderDossiers();
  } catch (err) {
    appendMessage("system", `Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btnSend.disabled = false;
  }
};

peerForm.onsubmit = async (e) => {
  e.preventDefault();
  const url = peerUrlInput.value.trim();
  const query = peerQueryInput.value.trim();
  let slyData: Record<string, unknown> = {};
  try {
    slyData = peerSlyInput.value.trim() ? (JSON.parse(peerSlyInput.value) as Record<string, unknown>) : {};
  } catch {
    appendMessage("system", "Invalid JSON in Simulated Private Context (sly_data).");
    return;
  }

  appendMessage("user", `[Peer Invocation] ${url}\nQuery: ${query}`);
  try {
    const { text } = await engine.runPeerQuery(url, query, slyData);
    appendMessage("assistant", text, `peer=${url}`);
  } catch (err) {
    appendMessage("system", `Peer composition blocked/failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

btnResetChat.onclick = () => {
  engine.resetHistory();
  chatFeed.innerHTML = "";
  appendMessage("system", "Conversation history cleared.");
};

btnClearTrace.onclick = () => {
  traceList.innerHTML = "";
};

void boot();
