// Background service worker. It's the only part of the extension that reads the saved keys
// and calls Jev, Nemotron or another AI. It opens the search box when the shortcut fires, and
// answers the requests the box sends it.

importScripts("net.js", "scorer.js", "nemotron.js", "ai.js", "compare.js");

// Keep saved data (including the keys) away from scripts running inside webpages.
try {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
} catch {
  // Older Chrome without setAccessLevel on local storage: nothing to do.
}

// Who writes the AI answer. "nemotron" is the default: Nemotron 3 Super on Nebius, with the
// Nebius key that also powers think harder. "hosted" is any OpenAI-compatible API. "local"
// runs the AI tools on this Mac through the bridge, and is opt-in. "off" means don't ask.
// CtrlF.AI_DEFAULTS (ai.js) holds the hosted endpoint and model, both editable in settings.
const DEFAULTS = { ...CtrlF.AI_DEFAULTS, aiAuto: true };

// jevApiKey, nebiusApiKey and hostedApiKey are in here. settings() below hands the whole
// object to Jev, Nemotron and the AI, which run in this worker; the `settings` message sends
// back only flags.
const SETTING_KEYS = [
  "jevApiKey", "nebiusApiKey", "hostedApiKey",
  "nebiusBaseUrl", "nebiusFastModel", "nebiusAnswerModel", "nebiusDeepModel",
  "hostedBaseUrl", "hostedModel", "aiProvider", "aiAuto",
];

// Meaning search (Jev, or Nemotron) and AI answers turn on when a Jev or Nebius key is saved.
// With neither, it's word-for-word find on this computer and nothing is sent anywhere.
// A "plan" saved by 1.6.0 or earlier isn't used any more.
chrome.storage.local.remove("plan");
// A Claude API key saved by 1.4.0 or earlier isn't used any more, so it isn't kept.
chrome.storage.local.remove("anthropicApiKey");

async function settings() {
  const saved = await chrome.storage.local.get(SETTING_KEYS);
  const s = { ...DEFAULTS, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined && v !== "")) };
  s.plan = s.jevApiKey || s.nebiusApiKey ? "ai" : "free";
  // "anthropic" was an answer option until 1.4.1 and is gone. Anything unrecognised, including
  // that, becomes the default. "local" is kept for everyone already using the bridge.
  if (!["nemotron", "hosted", "local", "off"].includes(s.aiProvider)) s.aiProvider = DEFAULTS.aiProvider;
  return s;
}

// Jev and the AI are only asked once a Jev or Nebius key is saved.
async function aiPlanSettings() {
  const s = await settings();
  if (s.plan !== "ai") throw Object.assign(new Error("Search by meaning needs a Jev or Nebius key."), { code: "free-plan" });
  return s;
}

// The shortcut and the toolbar button both open the box.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-search") openBox(tab);
});
chrome.action.onClicked.addListener(openBox);

const PAGE_FILES = ["pagereader.js", "chunker.js", "textmap.js", "citations.js", "wordfind.js", "searchbox.js"];

async function openBox(tab) {
  if (!tab?.id) return;
  // Normally the box is already loaded in the page (see content_scripts in the manifest), so
  // this is one quick message.
  if (await tellToOpen(tab.id)) return;
  // A tab that was open before the extension was installed or reloaded hasn't got it yet:
  // load it now, then open.
  try {
    await Promise.all([
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["highlight.css"] }),
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: PAGE_FILES }),
    ]);
    if (await tellToOpen(tab.id)) return;
  } catch (err) {
    // Chrome blocks extensions on its own pages (chrome://, the Web Store, the New Tab page,
    // and this extension's settings page). Say so, rather than doing nothing.
    console.warn("Pareto can't open on this page:", err.message);
  }
  cantOpenHere(tab);
}

async function tellToOpen(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "open" }, { frameId: 0 });
    return !!reply?.opened;
  } catch {
    return false; // nothing in the page is listening
  }
}

// A red ✕ on the toolbar icon for a few seconds, a tooltip saying why, and, when the page is
// this extension's own settings page, a note on that page.
async function cantOpenHere(tab) {
  const why = "Pareto can't open on this page. Chrome doesn't let extensions run on its own pages (like settings, chrome:// or the New Tab page). Open a normal website and try again.";
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#d93025" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "✕" });
    await chrome.action.setTitle({ tabId: tab.id, title: why });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
      chrome.action.setTitle({ tabId: tab.id, title: "Pareto (Control+Shift+F)" }).catch(() => {});
    }, 5000);
  } catch {
    // The tab closed.
  }
  // An open settings page shows the note only if it's the page the shortcut was pressed on.
  chrome.runtime.sendMessage({ type: "cantOpenHere", tabId: tab.id }).catch(() => {});
}

// While Ultra thinks, nothing else happens in this worker for a minute or more, and Chrome
// stops a worker that's idle for 30 seconds. Calling any extension API resets that clock.
function keepAwake() {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  return () => clearInterval(timer);
}

// Requests from the search box. Only this extension's own scripts can send these; webpages can't.
const HANDLERS = {
  // { question, chunks: [{ id, text, path }] } → the top 5 and how sure it is. Jev first, and
  // Nemotron Lightning when there's no Jev key or Jev can't do it (nemotron.js says when).
  async search({ question, chunks }) {
    const s = await aiPlanSettings();
    return CtrlF.nemotron.findAnswer(chunks, question, s);
  },
  // { question, sentences, path, engine } → which sentence answers it, from the same engine
  async sentence({ question, sentences, path, engine }) {
    const s = await aiPlanSettings();
    return CtrlF.nemotron.findSentence(sentences, question, s, { path, engine });
  },
  // { question, title, url, chunks } → think harder: Nemotron 3 Ultra reads the whole page and
  // answers, with the lines it used. Progress goes to the tab that asked, as it streams in.
  async deep({ question, title, url, chunks }, sender) {
    const s = await aiPlanSettings();
    const tabId = sender?.tab?.id;
    let last = 0;
    const onProgress = (p) => {
      const now = Date.now();
      if (tabId == null || now - last < 300) return;
      last = now;
      chrome.tabs.sendMessage(tabId, { type: "deepProgress", ...p }, { frameId: 0 }).catch(() => {});
    };
    const wake = keepAwake();
    try {
      return await CtrlF.nemotron.thinkHarder({ question, title, url, chunks }, s, { onProgress });
    } finally {
      wake();
    }
  },
  // { question, title, url, excerpts } → a short written answer
  async ask({ question, title, url, excerpts }) {
    const s = await aiPlanSettings();
    return CtrlF.askAI({ question, title, url, excerpts }, s);
  },
  // { question, chunks } → the compare model's pick and time
  async compare({ question, chunks }) {
    const s = await aiPlanSettings();
    return CtrlF.comparePick(chunks, question, s);
  },
  // What the box needs to know, without any keys: whether one is saved, never which.
  async settings() {
    const s = await settings();
    return {
      plan: s.plan,
      aiProvider: s.aiProvider,
      aiAuto: s.aiAuto,
      hasJevKey: !!s.jevApiKey,
      hasNebiusKey: !!s.nebiusApiKey,
      hasHostedKey: !!s.hostedApiKey,
    };
  },
  // How the AI answers are set up right now: the chosen provider's own view of itself.
  async providerStatus() {
    const s = await settings();
    return { provider: s.aiProvider, ...(await CtrlF.providerStatus(s)) };
  },
  async bridgeStatus() {
    return CtrlF.bridgeStatus();
  },
  // Whether the Nebius key works, and which of the three Nemotron models it can use.
  async nebiusStatus() {
    return CtrlF.nemotron.status(await settings());
  },
  async openSettings() {
    await chrome.runtime.openOptionsPage();
    return true;
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return;
  handler(message, sender).then(
    (result) => sendResponse({ result }),
    (err) => {
      console.warn(`Pareto ${message.type} failed:`, err.message);
      sendResponse({ error: { code: err.code ?? "error", message: err.message, status: err.status, max: err.max, tried: err.tried, service: err.service } });
    },
  );
  return true; // the answer comes later
});
