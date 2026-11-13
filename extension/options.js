// Settings page: saves the keys and the AI-answer choices, checks the Nebius key and
// the local AI bridge, and shows the shortcut. Saved keys are never shown again, even here.

const $ = (id) => document.getElementById(id);

function state(el, text, good) {
  el.textContent = text;
  el.className = `state${good === undefined ? "" : good ? " good" : " bad"}`;
}


// Must match CtrlF.AI_DEFAULTS in ai.js. This page can't see the worker's globals.
const HOSTED_DEFAULTS = { baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna" };
// Must match the defaults in nemotron.js.
const NEBIUS_DEFAULTS = {
  baseUrl: "https://api.tokenfactory.us-central1.nebius.com/v1",
  fast: "nvidia/Nemotron-3_5-Lightning",
  answer: "nvidia/nemotron-3-super-120b-a12b",
  deep: "nvidia/Nemotron-3-Ultra-550b-a55b",
};
const PROVIDERS = ["nemotron", "hosted", "local", "off"];
const DEFAULT_PROVIDER = "nemotron";

// The hosted key and endpoint only matter when hosted answers are in play. They stay visible
// when "local" is picked, because local can fall back to hosted if the helper isn't installed.
function showProvider(provider) {
  document.querySelectorAll("input[name=provider]").forEach((r) => (r.checked = r.value === provider));
  $("hosted-card").hidden = !["hosted", "local"].includes(provider);
}

// ⌘ Enter on a Mac, Ctrl+Enter elsewhere, as in the search box.
const onMac = /Mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
for (const id of ["deep-key", "deep-key-2"]) $(id).textContent = onMac ? "⌘ Enter" : "Ctrl Enter";

async function refresh() {
  const s = await chrome.storage.local.get([
    "jevApiKey", "nebiusApiKey", "hostedApiKey", "hostedBaseUrl", "hostedModel",
    "nebiusBaseUrl", "nebiusFastModel", "nebiusAnswerModel", "nebiusDeepModel",
    "aiProvider", "aiAuto", "look",
  ]);
  const look = s.look === "terminal" ? "terminal" : "digital";
  document.body.dataset.look = look;
  document.querySelectorAll("input[name=look]").forEach((r) => (r.checked = r.value === look));
  state($("jev-state"), s.jevApiKey ? "A Jev key is saved." : "No Jev key saved yet.", !!s.jevApiKey);
  state($("nebius-state"), s.nebiusApiKey ? "A Nebius key is saved." : "No Nebius key saved yet.", !!s.nebiusApiKey);
  $("nebius-base").value = s.nebiusBaseUrl ?? "";
  $("nebius-fast").value = s.nebiusFastModel ?? "";
  $("nebius-answer").value = s.nebiusAnswerModel ?? "";
  $("nebius-deep").value = s.nebiusDeepModel ?? "";
  showProvider(PROVIDERS.includes(s.aiProvider) ? s.aiProvider : DEFAULT_PROVIDER);
  state($("hosted-state"), s.hostedApiKey ? "A hosted AI key is saved." : "No hosted AI key saved yet.", !!s.hostedApiKey);
  $("hosted-base").value = s.hostedBaseUrl ?? "";
  $("hosted-model").value = s.hostedModel ?? "";
  $("ai-auto").checked = s.aiAuto ?? true;
}

function saveKey(formId, inputId, storageKey, stateId, label) {
  $(formId).addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = $(inputId).value.trim();
    if (!key) return state($(stateId), "Paste a key first.", false);
    await chrome.storage.local.set({ [storageKey]: key });
    $(inputId).value = "";
    state($(stateId), `Saved. ${label} key is stored in this browser only.`, true);
  });
}
saveKey("jev-form", "jev-key", "jevApiKey", "jev-state", "Your Jev");
saveKey("nebius-form", "nebius-key", "nebiusApiKey", "nebius-state", "Your Nebius");
saveKey("hosted-form", "hosted-key", "hostedApiKey", "hosted-state", "Your hosted AI");


document.querySelectorAll("input[name=provider]").forEach((radio) =>
  radio.addEventListener("change", async () => {
    await chrome.storage.local.set({ aiProvider: radio.value });
    showProvider(radio.value);
    state($("bridge-state"), "");
  }),
);
$("ai-auto").addEventListener("change", (event) => chrome.storage.local.set({ aiAuto: event.target.checked }));

// A custom endpoint needs Chrome's permission before the worker can reach it. The ones in the
// manifest (Jev, Nebius and OpenAI) are already granted, so this is a no-op for the defaults.
async function allowEndpoint(url) {
  let origin;
  try {
    origin = new URL(url).origin + "/*";
  } catch {
    return { ok: false, why: "That isn't a web address. It should look like https://api.openai.com/v1" };
  }
  if (!url.startsWith("https://")) return { ok: false, why: "The endpoint must start with https://" };
  if (await chrome.permissions.contains({ origins: [origin] })) return { ok: true };
  const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  return granted ? { ok: true } : { ok: false, why: `Chrome wasn't given permission to reach ${origin}, so answers from it would fail.` };
}

$("hosted-endpoint-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const el = $("hosted-endpoint-state");
  const base = $("hosted-base").value.trim();
  const model = $("hosted-model").value.trim();
  if (base) {
    const allowed = await allowEndpoint(base);
    if (!allowed.ok) return state(el, allowed.why, false);
  }
  await chrome.storage.local.set({ hostedBaseUrl: base, hostedModel: model });
  state(el, `Saved. Using ${base || HOSTED_DEFAULTS.baseUrl} and ${model || HOSTED_DEFAULTS.model}.`, true);
});

$("nebius-endpoint-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const el = $("nebius-endpoint-state");
  const base = $("nebius-base").value.trim();
  if (base) {
    const allowed = await allowEndpoint(base);
    if (!allowed.ok) return state(el, allowed.why, false);
  }
  const models = { nebiusFastModel: $("nebius-fast").value.trim(), nebiusAnswerModel: $("nebius-answer").value.trim(), nebiusDeepModel: $("nebius-deep").value.trim() };
  await chrome.storage.local.set({ nebiusBaseUrl: base, ...models });
  state(el, `Saved. Using ${base || NEBIUS_DEFAULTS.baseUrl}.`, true);
});

$("nebius-reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(["nebiusBaseUrl", "nebiusFastModel", "nebiusAnswerModel", "nebiusDeepModel"]);
  for (const id of ["nebius-base", "nebius-fast", "nebius-answer", "nebius-deep"]) $(id).value = "";
  state($("nebius-endpoint-state"), "Back to the default endpoint and models.", true);
});

// Lists the models the key can use. Nebius doesn't charge for this.
$("check-nebius").addEventListener("click", async () => {
  const el = $("nebius-check-state");
  state(el, "Checking…");
  const reply = await chrome.runtime.sendMessage({ type: "nebiusStatus" }).catch((err) => ({ error: { message: err.message } }));
  const status = reply?.result;
  if (!status) return state(el, reply?.error?.message ?? "Couldn't check.", false);
  const tools = status.tools ? `  ${Object.entries(status.tools).map(([name, ok]) => `${name} ${ok ? "✓" : "✗"}`).join("  ")}` : "";
  state(el, `${status.detail}${tools}`, status.ok && (!status.tools || Object.values(status.tools).every(Boolean)));
});

$("hosted-reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(["hostedBaseUrl", "hostedModel"]);
  $("hosted-base").value = "";
  $("hosted-model").value = "";
  state($("hosted-endpoint-state"), `Back to ${HOSTED_DEFAULTS.baseUrl} and ${HOSTED_DEFAULTS.model}.`, true);
});

// Checks whichever provider is picked, and says what to do when it isn't ready.
$("check-provider").addEventListener("click", async () => {
  const el = $("bridge-state");
  state(el, "Checking…");
  const reply = await chrome.runtime.sendMessage({ type: "providerStatus" }).catch((err) => ({ error: { message: err.message } }));
  const status = reply?.result;
  if (!status) return state(el, reply?.error?.message ?? "Couldn't check.", false);
  if (status.provider === "off") return state(el, "AI answers are off, so nothing is asked.");
  if (status.ok) {
    const tools = status.tools ? ` ${Object.entries(status.tools).map(([name, ok]) => `${name} ${ok ? "✓" : "✗"}`).join("  ")}` : "";
    const working = status.tools ? Object.values(status.tools).some(Boolean) : true;
    return state(el, `${status.detail}${tools}`, working);
  }
  if (status.provider === "local") {
    const { hostedApiKey } = await chrome.storage.local.get("hostedApiKey");
    return state(el, hostedApiKey
      ? "The AI helper isn't set up, so answers will use the hosted AI instead. To use the tools on this Mac, run ./setup.sh in the project folder in Terminal, then check again."
      : "The AI helper isn't set up. In Terminal, run ./setup.sh in the project folder, then check again — or save a hosted AI key below and switch to Hosted AI.", false);
  }
  state(el, status.detail, false);
});

async function showShortcut() {
  const commands = await chrome.commands.getAll();
  const openSearch = commands.find((command) => command.name === "open-search");
  $("shortcut").textContent = openSearch?.shortcut || "not set";
}

$("change-shortcut").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

// The pinned Wikipedia page from the test set: a known page to try the box on.
const TEST_PAGE = "https://en.wikipedia.org/w/index.php?title=Artificial_intelligence&oldid=1376335904";
document.querySelectorAll(".try-it").forEach((b) => b.addEventListener("click", () => chrome.tabs.create({ url: TEST_PAGE })));

// The shortcut was pressed on this page, where Chrome won't let the box open: say why.
chrome.runtime.onMessage.addListener(async (message) => {
  if (message?.type !== "cantOpenHere") return;
  const me = await chrome.tabs.getCurrent();
  if (me && me.id !== message.tabId) return;
  $("notice").hidden = false;
  $("notice").scrollIntoView({ block: "nearest" });
});
$("ext-id").textContent = chrome.runtime.id;
$("version").textContent = chrome.runtime.getManifest().version;

refresh();
showShortcut();

// The look: the box on every page switches as soon as it's saved.
document.querySelectorAll("input[name=look]").forEach((radio) =>
  radio.addEventListener("change", async () => {
    await chrome.storage.local.set({ look: radio.value });
    document.body.dataset.look = radio.value;
  }),
);
