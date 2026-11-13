// Runs the real extension in a hidden, throwaway Chrome and searches the pinned test page.
// Your own Chrome and profile are not touched: this starts a separate headless Chrome with a
// temporary profile, loads a copy of extension/ into it, and deletes both afterwards.
//
//   CTRLF_TMP=<scratch folder> node tests/chrome-check.mjs [--questions 1,9] [--no-ai] [--no-extras]
//
// It checks, through the real box and real Jev:
//   - the 10 test questions: paragraph hit or miss, Enter-to-highlight time, the sentence
//     picked, the sources listed, and (unless --no-ai) the AI answer through the real bridge
//   - word-for-word matches and Shift+↓, and compare mode with Option+Enter (unless --no-extras)
//   - that setup.sh's extension-ID formula matches the ID Chrome gives the unpacked copy
//
// The Jev key comes from the macOS Keychain (typesafe-jev), is handed to the extension's own
// storage without appearing in any script text, and is never printed. Jev calls are logged
// in spend.md.
//
// Test-only differences from what the user installs:
// - The copy's manifest also has host permission for en.wikipedia.org: the box is opened by
//   calling the worker's own openBox(tab), and without a real key press there's no activeTab grant.
// - The service worker's fetch is wrapped to count Jev tokens for spend.md.
// - The AI bridge is registered in the temporary profile only.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEND = join(ROOT, ".scratch/ctrl-f-by-meaning/spend.md");
const PRICE_PER_TOKEN = 0.042 / 1e6;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = "https://en.wikipedia.org/w/index.php?title=Artificial_intelligence&oldid=1376335904";
const SCRATCH = process.env.CTRLF_TMP || tmpdir();
const TMP = mkdtempSync(join(SCRATCH, "ctrlf-chrome-check-"));
const SHOTS = join(SCRATCH, "chrome-check-shots");
const RESULTS = join(SCRATCH, "chrome-check-results.json");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const pick = args.includes("--questions") ? args[args.indexOf("--questions") + 1].split(",").map(Number) : null;

// From tests/test-set.md. `accept` holds the opening words of each accepted paragraph.
const TESTS = [
  { q: "when did a computer first beat the world chess champion", accept: ["Game playing programs have been used since the 1950s"] },
  { q: "how much more electricity does a chatgpt question use than a google search", accept: ["Power consumption by AI is responsible for an increase in fossil fuel use"] },
  { q: "have lawyers gotten in trouble for using AI that made up fake cases", accept: ["The use of generative AI by law firms for legal research"] },
  { q: "can an algorithm be racist even if it's never told anyone's race", accept: ["A program can make biased decisions even if the data does not explicitly mention", "COMPAS is a commercial program widely used by U.S. courts"] },
  { q: "when did AI start as a field", accept: ["The field of AI research was founded at a workshop at Dartmouth College", "Artificial intelligence was founded as an academic discipline in 1956"] },
  { q: "what's the difference between supervised and unsupervised learning", accept: ["Supervised learning requires labelling the training data", "Unsupervised learning analyses a stream of data", "In supervised learning, the training data is labelled with the expected answers"] },
  { q: "what's the movie with the killer computer on a spaceship", accept: ["A common trope in these works began with Mary Shelley"] },
  { q: "are tech companies really reopening old nuclear plants for AI", accept: ["In September 2024, Microsoft announced an agreement with Constellation Energy", "In 2024, The Wall Street Journal reported that big AI companies have begun negotiations"] },
  { q: "how much does chatgpt cost per month", accept: [] },
  { q: "how do i cancel my netflix subscription", accept: [] },
];
const run = (pick ?? TESTS.map((_, i) => i + 1)).map((n) => ({ n, ...TESTS[n - 1] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = execFileSync("security", ["find-generic-password", "-s", "typesafe-jev", "-w"]).toString().trim();
const idFor = (path) => [...createHash("sha256").update(path).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

// A copy of the extension with the test-only host permission.
const EXT = join(TMP, "extension");
cpSync(join(ROOT, "extension"), EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
manifest.host_permissions.push("https://en.wikipedia.org/*");
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));
const PROFILE = join(TMP, "profile");
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`, "--headless", "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,900", "about:blank",
], { stdio: ["ignore", "ignore", flag("--debug") ? "pipe" : "ignore", "pipe", "pipe"] });
if (flag("--debug")) chrome.stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (/native|bridge|node|host|error/i.test(l)) console.log(`[chrome] ${l.slice(0, 300)}`); });

// Chrome DevTools Protocol over the pipe: JSON messages ending in \0.
let nextId = 1;
const pending = new Map();
const listeners = new Set();
let buffer = "";
chrome.stdio[4].setEncoding("utf8");
chrome.stdio[4].on("data", (data) => {
  buffer += data;
  for (let end; (end = buffer.indexOf("\0")) >= 0; ) {
    const msg = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function waitFor(test, ms = 30000, what = "an event") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error(`Timed out waiting for ${what}`)); }, ms);
    const l = (msg) => { if (test(msg)) { clearTimeout(timer); listeners.delete(l); resolve(msg); } };
    listeners.add(l);
  });
}
async function evaluate(expression, sessionId) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const problems = [];
const results = [];
let tokens = 0;
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  return ok;
};

try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  check(extId === idFor(EXT), `setup.sh's ID formula matches Chrome's ID for an unpacked folder (${extId})`);

  // Register the real AI bridge for this test profile only.
  if (!flag("--no-ai") || !flag("--no-extras")) {
    // A copy outside Documents, as setup.sh does: macOS won't let Chrome start programs in there.
    cpSync(join(ROOT, "ai-bridge"), join(TMP, "ai-bridge"), { recursive: true });
    mkdirSync(join(PROFILE, "NativeMessagingHosts"), { recursive: true });
    writeFileSync(join(PROFILE, "NativeMessagingHosts", "com.ctrlf_by_meaning.bridge.json"), JSON.stringify({
      name: "com.ctrlf_by_meaning.bridge", description: "test", path: join(TMP, "ai-bridge/ctrlf-bridge"),
      type: "stdio", allowed_origins: [`chrome-extension://${extId}/`],
    }));
  }

  // The background service worker.
  let worker;
  for (let i = 0; i < 50 && !worker; i++) {
    const { targetInfos } = await send("Target.getTargets");
    worker = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!worker) await sleep(200);
  }
  if (!worker) throw new Error("The extension's service worker didn't start.");
  const { sessionId: sw } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });

  // Save the key the way the settings page does, without it appearing in any script text.
  const { result: global } = await send("Runtime.evaluate", { expression: "globalThis" }, sw);
  const saved = await send("Runtime.callFunctionOn", {
    objectId: global.objectId, awaitPromise: true, returnByValue: true,
    functionDeclaration: "function (key) { return chrome.storage.local.set({ jevApiKey: key, aiAuto: true, aiProvider: 'local' }).then(() => 'saved'); }",
    arguments: [{ value: KEY }],
  }, sw).catch(() => null);
  if (saved?.result?.value !== "saved") throw new Error("Couldn't save the key in the test profile.");

  const bridge = await evaluate("CtrlF.bridgeStatus()", sw);
  check(bridge.ok, `AI bridge reachable from the extension: ${bridge.ok ? Object.entries(bridge.tools).map(([t, ok]) => `${t} ${ok ? "✓" : "✗"}`).join(" ") : bridge.error}`);

  // Count Jev tokens for spend.md.
  await evaluate(`
    globalThis.__jevTokens = 0;
    const realFetch = fetch;
    globalThis.fetch = async (...args) => {
      const res = await realFetch(...args);
      if (res.ok && String(args[0]).includes("typesafe")) res.clone().json().then((j) => { globalThis.__jevTokens += j.usage?.input_tokens ?? 0; }).catch(() => {});
      return res;
    };
    "ok"`, sw);

  // The test page.
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, page);
  await send("Runtime.enable", {}, page);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, page);
  await send("Page.bringToFront", {}, page);
  listeners.add((msg) => {
    if (msg.sessionId === page && msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const loaded = waitFor((m) => m.sessionId === page && m.method === "Page.loadEventFired", 60000, "the page to load");
  await send("Page.navigate", { url: PAGE }, page);
  await loaded;

  const logged = (prefix, ms = 30000) => waitFor(
    (m) => m.sessionId === page && m.method === "Runtime.consoleAPICalled" && m.params.type === "log" && String(m.params.args[0]?.value).startsWith(prefix),
    ms, `the console line "${prefix}"`,
  ).then((m) => String(m.params.args[0].value));

  // Open the box with the worker's own openBox, which the shortcut and toolbar button call.
  const opened = logged("Pareto read");
  await evaluate(`chrome.tabs.query({ url: "https://en.wikipedia.org/*" }).then(([tab]) => openBox(tab)).then(() => "ok")`, sw);
  console.log(await opened);

  // What's on screen: highlighted text (the page shares the extension's highlight registry)
  // and text inside the box (read through its closed shadow root).
  const lit = (name) => evaluate(`(() => { const h = CSS.highlights.get(${JSON.stringify(name)}); return h ? [...h].map((r) => r.toString().replace(/\\s+/g, " ").trim()) : null; })()`, page);
  async function box() {
    const { root } = await send("DOM.getDocument", { depth: 1 }, page);
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#ctrlf-by-meaning" }, page);
    const { node } = await send("DOM.describeNode", { nodeId, depth: -1, pierce: true }, page);
    const classOf = (n) => { const a = n.attributes ?? []; const i = a.indexOf("class"); return i >= 0 && i % 2 === 0 ? a[i + 1].split(" ") : []; };
    const attr = (n, name) => { const a = n.attributes ?? []; const i = a.indexOf(name); return i >= 0 && i % 2 === 0 ? a[i + 1] : null; };
    const find = (n, cls) => {
      if (classOf(n).includes(cls)) return n;
      for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) { const f = find(c, cls); if (f) return f; }
      return null;
    };
    const text = (n) => (n ? (n.nodeType === 3 ? n.nodeValue : [...(n.children ?? [])].map(text).join("")) : "");
    const shown = (cls) => { const n = find(node, cls); return !!n && attr(n, "hidden") === null; };
    return {
      status: text(find(node, "status")).trim(),
      words: shown("words") ? text(find(node, "words-label")) : null,
      sources: shown("sources") ? (find(node, "sources")?.children?.find((c) => classOf(c).includes("content"))?.children?.[0]?.children ?? []).map((li) => text(li).trim()) : [],
      aiShown: shown("ai"),
      answer: text(find(node, "answer")).trim(),
      aiFoot: text(find(node, "foot")).trim(),
      aiLabel: text(find(node, "ai-label")).trim(),
      compare: shown("compare") ? text(find(node, "verdict")).trim() : null,
      vs: shown("compare") ? text(find(node, "vs")).replace(/\s+/g, " ").trim() : null,
    };
  }
  async function key(keyName, code, extra = {}) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, ...extra }, page);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers: extra.modifiers }, page);
  }
  async function type(text) {
    await key("a", "KeyA", { modifiers: 4, commands: ["selectAll"] });
    await send("Input.insertText", { text }, page);
  }
  async function until(test, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
      const b = await box();
      if (test(b)) return b;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await sleep(250);
    }
  }
  async function shot(name) {
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await send("Page.captureScreenshot", { format: "png" }, page);
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  }

  // ---------- The 10 test questions ----------
  const times = [];
  let hits = 0;
  for (const t of run) {
    await type(t.q);
    const line = logged(`Pareto: "${t.q}"`);
    await key("Enter", "Enter", { windowsVirtualKeyCode: 13, text: "\r" });
    const log = await line;
    const ms = Number(log.match(/Enter to highlight (\d+) ms/)?.[1]);
    const para = await lit("ctrlf-match");
    let b = await box();
    const ok = t.accept.length
      ? para?.length > 0 && t.accept.some((a) => para[0].startsWith(a))
      : (para?.length ?? 0) === 0 && b.status.startsWith("Not found on this page");
    if (ok) hits++;
    if (Number.isFinite(ms)) times.push(ms);

    // The sentence and its sources arrive a moment later.
    let sentence = null;
    if (t.accept.length) {
      for (let i = 0; i < 20 && !sentence?.length; i++) { await sleep(150); sentence = await lit("ctrlf-sentence"); }
      b = await box();
    }
    // The AI answer.
    if (!flag("--no-ai")) b = await until((x) => x.aiShown && !/^Thinking/.test(x.answer), 150000, "the AI answer");

    const r = { n: t.n, q: t.q, hit: ok, ms, status: b.status, paragraph: para?.[0]?.slice(0, 90) ?? null, sentence: sentence?.[0] ?? null, sources: b.sources, answer: b.answer, answeredBy: b.aiFoot };
    results.push(r);
    check(ok, `${t.n}. ${t.q}
     box:       ${b.status}
     paragraph: ${r.paragraph ? `"${r.paragraph}…"` : "nothing highlighted"}
     sentence:  ${r.sentence ? `"${r.sentence.slice(0, 160)}"` : "-"}
     sources:   ${r.sources.length ? r.sources.map((s) => s.slice(0, 90)).join("\n                ") : "-"}
     AI:        ${flag("--no-ai") ? "(skipped)" : `${r.answer.replace(/\n/g, " ").slice(0, 220)}\n                (${r.answeredBy})`}`);
    if (t.accept.length) check(!!r.sentence && para.some((p) => p.includes(r.sentence.slice(0, 40))), `   the sentence is inside the highlighted paragraph`);
    if (t.n === 1) await shot("q1-answer");
    if (t.n === 9) await shot("q9-not-found");
  }
  times.sort((a, b) => a - b);
  const median = times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
  console.log(`\n${hits} of ${run.length} right. Enter to highlight: median ${median} ms, slowest ${times.at(-1)} ms.\n`);

  if (!flag("--no-extras")) {
    // ---------- Word for word ----------
    await type("Kasparov");
    const kLine = logged(`Pareto: "Kasparov"`);
    await key("Enter", "Enter", { windowsVirtualKeyCode: 13, text: "\r" });
    await kLine;
    const wordBox = await box();
    const wordLit = await lit("ctrlf-word");
    check(!!wordBox.words && wordLit?.length > 0 && wordLit.every((w) => w.toLowerCase() === "kasparov"), `word for word "Kasparov": ${wordBox.words} (${wordLit?.length} highlighted)`);
    await key("ArrowDown", "ArrowDown", { windowsVirtualKeyCode: 40, modifiers: 8 });
    const now = await lit("ctrlf-word-now");
    const after = await box();
    check(now?.[0]?.toLowerCase() === "kasparov" && /1 of|2 of/.test(after.words ?? ""), `Shift+↓ steps the word matches: ${after.words}`);
    await shot("word-for-word");
    if (!flag("--no-ai")) await until((x) => !/^Thinking/.test(x.answer), 150000, "the AI answer");

    // ---------- Compare (Option+Enter) ----------
    await type(TESTS[0].q);
    await key("Enter", "Enter", { windowsVirtualKeyCode: 13, text: "\r", modifiers: 1 });
    const cmp = await until((x) => x.compare && x.compare !== "Asking both…", 180000, "the compare result");
    check(/Same paragraph|Different paragraphs/.test(cmp.compare), `compare mode: ${cmp.vs}\n     ${cmp.compare}`);
    await shot("compare");
    results.push({ compare: cmp.compare, vs: cmp.vs });
  }

  if (!flag("--no-extras")) {
    // ---------- The settings page ----------
    const { targetId: optionsTarget } = await send("Target.createTarget", { url: `chrome-extension://${extId}/options.html` });
    const { sessionId: options } = await send("Target.attachToTarget", { targetId: optionsTarget, flatten: true });
    await sleep(800);
    await evaluate(`document.getElementById("check-bridge").click()`, options);
    let bridgeLine = "";
    for (let i = 0; i < 40 && !/Bridge ready|isn't set up/.test(bridgeLine); i++) {
      await sleep(250);
      bridgeLine = await evaluate(`document.getElementById("bridge-state").textContent`, options);
    }
    const jevLine = await evaluate(`document.getElementById("jev-state").textContent`, options);
    check(/Bridge ready/.test(bridgeLine) && /saved/.test(jevLine), `settings page: "${jevLine}" · "${bridgeLine}"`);
    // Opening the box on the settings page itself can't work (Chrome blocks extensions on
    // extension pages), so it must say so: a ✕ badge, and a note on the page.
    const optionsTab = await evaluate(`chrome.tabs.getCurrent().then((t) => t.id)`, options);
    const badge = await evaluate(`chrome.tabs.get(${optionsTab}).then(async (t) => { await openBox(t); await new Promise((r) => setTimeout(r, 300)); return chrome.action.getBadgeText({ tabId: t.id }); })`, sw);
    const noticeShown = await evaluate(`!document.getElementById("notice").hidden`, options);
    check(badge === "✕" && noticeShown, `shortcut on the settings page explains itself: badge "${badge}", note shown: ${noticeShown}`);
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false }, options);
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, options);
    writeFileSync(join(SHOTS, "settings.png"), Buffer.from(data, "base64"));
    await send("Target.closeTarget", { targetId: optionsTarget });
    await send("Target.activateTarget", { targetId });
  }

  // Esc closes the box and removes every highlight.
  await key("Escape", "Escape", { windowsVirtualKeyCode: 27 });
  const gone = await evaluate(`!document.getElementById("ctrlf-by-meaning") && ["ctrlf-match","ctrlf-sentence","ctrlf-word","ctrlf-word-now"].every((n) => !CSS.highlights.has(n))`, page);
  check(gone, "Esc closes the box and removes every highlight");

  tokens = await evaluate("globalThis.__jevTokens", sw);
  for (const p of problems) check(false, `Page error: ${p}`);
  writeFileSync(RESULTS, JSON.stringify({ date: new Date().toISOString(), hits, of: run.length, median, slowest: times.at(-1), results }, null, 1));
} catch (err) {
  failures++;
  console.log(`✗ ${err.message}`);
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true }); // the profile holds the key
}

if (tokens) {
  const cost = tokens * PRICE_PER_TOKEN;
  const log = readFileSync(SPEND, "utf8").trimEnd().split("\n");
  const before = Number(log.at(-1).split("|").map((s) => s.trim())[5]?.replace("$", "")) || 0;
  const date = new Date().toLocaleDateString("en-CA");
  appendFileSync(SPEND, `| ${date} | Chrome check (tests/chrome-check.mjs), ${run.length} questions + extras | ${tokens} | $${cost.toFixed(6)} | $${(before + cost).toFixed(6)} |\n`);
  console.log(`${tokens} Jev input tokens, $${cost.toFixed(4)}. Running total $${(before + cost).toFixed(4)}.`);
}
console.log(`Screenshots: ${SHOTS}\nResults: ${RESULTS}`);
console.log(failures ? `${failures} FAILED` : "All passed");
process.exit(failures ? 1 : 0);
