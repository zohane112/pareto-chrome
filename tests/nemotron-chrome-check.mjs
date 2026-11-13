// Runs the real extension in a hidden, throwaway Chrome against a stand-in Nebius Token Factory
// on this computer (tests/mock-tokenfactory.mjs), so the Nemotron paths can be checked end to
// end without a Nebius key and without spending anything. Your own Chrome isn't touched.
//
//   CTRLF_TMP=<scratch folder> node tests/nemotron-chrome-check.mjs
//
// It checks, through the real box, worker and settings page:
//   1. Only a Nebius key: Enter → Lightning finds the paragraph, the status line says
//      "Lightning", Lightning picks the sentence, and Nemotron 3 Super writes the answer
//   2. ⌘ Enter → Ultra thinks harder: the answer panel shows "thinking · N words" while the
//      reply streams, then the answer, and the lines Ultra used are highlighted
//   3. Option+Enter → compare mode runs Lightning
//   4. A Nebius refusal for lack of credit reads as Nebius's problem, not Jev's
//   5. A Jev key that Jev refuses → Lightning takes over and the status line says why
//      (this one makes one free call to the real Jev with a made-up key, which Jev refuses)
//   6. The settings page's "Check the key" lists the three models
// Screenshots go to <scratch>/nemotron-shots/.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-tokenfactory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SCRATCH = process.env.CTRLF_TMP || tmpdir();
const TMP = mkdtempSync(join(SCRATCH, "ctrlf-nemotron-check-"));
const SHOTS = join(SCRATCH, "nemotron-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMock();
const PAGE = `${mock.url}/page.html`;

// A copy of the extension that may reach the stand-in server.
const EXT = join(TMP, "extension");
cpSync(join(ROOT, "extension"), EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
manifest.host_permissions.push("http://127.0.0.1/*");
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));
const PROFILE = join(TMP, "profile");
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`, "--headless", "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,900", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

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
let failures = 0;
let checks = 0;
const check = (ok, label, extra = "") => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${!ok && extra ? ` — ${extra}` : ""}`);
  return ok;
};

try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  let worker;
  for (let i = 0; i < 50 && !worker; i++) {
    const { targetInfos } = await send("Target.getTargets");
    worker = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!worker) await sleep(200);
  }
  if (!worker) throw new Error("The extension's service worker didn't start.");
  const { sessionId: sw } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const store = (values) => evaluate(`chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(values)})).then(() => "ok")`, sw);
  const NEBIUS = { nebiusApiKey: "mock-key", nebiusBaseUrl: `${mock.url}/v1`, aiAuto: true };
  await store(NEBIUS);

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, page);
  await send("Runtime.enable", {}, page);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, page);
  await send("Page.bringToFront", {}, page);
  listeners.add((msg) => {
    if (msg.sessionId === page && msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const loaded = waitFor((m) => m.sessionId === page && m.method === "Page.loadEventFired", 30000, "the page to load");
  await send("Page.navigate", { url: PAGE }, page);
  await loaded;

  const logged = (prefix, ms = 30000) => waitFor(
    (m) => m.sessionId === page && m.method === "Runtime.consoleAPICalled" && m.params.type === "log" && String(m.params.args[0]?.value).startsWith(prefix),
    ms, `the console line "${prefix}"`,
  ).then((m) => String(m.params.args[0].value));

  const opened = logged("Pareto read");
  await evaluate(`chrome.tabs.query({ url: "${mock.url}/*" }).then(([tab]) => openBox(tab)).then(() => "ok")`, sw);
  await opened;

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
      status: text(find(node, "status")).replace(/\s+/g, " ").trim(),
      quote: shown("quote") ? text(find(node, "quote-text")).trim() : null,
      aiShown: shown("ai"),
      answer: text(find(node, "answer")).trim(),
      aiFoot: text(find(node, "foot")).trim(),
      hints: text(find(node, "hints")).replace(/\s+/g, " ").trim(),
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
  const ENTER = { windowsVirtualKeyCode: 13, text: "\r" };
  const META = 4;
  const ALT = 1;
  async function until(test, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
      const b = await box();
      if (test(b)) return b;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(b)}`);
      await sleep(150);
    }
  }
  async function shot(name, sessionId = page) {
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  }

  const b0 = await box();
  check(/think harder/.test(b0.hints), "the key hints show think harder", b0.hints);

  // ---------- 1. Only a Nebius key: Lightning finds, Super answers ----------
  console.log("\n1. Only a Nebius key");
  await type("do children ride free");
  const line = logged('Pareto: "do children ride free');
  await key("Enter", "Enter", ENTER);
  console.log(`  ${await line}`);
  const para = await lit("ctrlf-match");
  check(para?.[0]?.startsWith("A single adult ticket costs 6 dollars"), "Lightning highlights the fares paragraph", para?.[0]);
  let b = await until((x) => /Lightning/.test(x.status), 5000, "the status line");
  check(/this page answers it/.test(b.status) && /Lightning · \d+ ms/.test(b.status), `the status line names Lightning: "${b.status}"`);
  b = await until((x) => x.quote?.includes("Children under twelve"), 8000, "the sentence");
  check(true, "Lightning picks the sentence about children");
  b = await until((x) => x.aiFoot.startsWith("Nemotron 3 Super ·") && x.answer !== "thinking", 10000, "the written answer");
  check(b.answer.startsWith("From the page:"), `Nemotron 3 Super writes the answer: "${b.answer}" (${b.aiFoot})`);
  await shot("1-lightning-and-super");
  const sentKinds = mock.requests.filter((r) => r.kind !== "models").map((r) => r.kind);
  check(["find", "sentence", "answer"].every((k) => sentKinds.includes(k)), `the worker asked Lightning to find, Lightning for the sentence, and Super to answer (${sentKinds.join(", ")})`);
  check(mock.requests.filter((r) => r.kind !== "deep").every((r) => r.thinking === false), "…all with reasoning off");

  // ---------- 2. ⌘ Enter: Ultra thinks harder ----------
  console.log("\n2. ⌘ Enter: think harder");
  await type("what changed about the boat's engines and when was it built");
  await key("Enter", "Enter", { ...ENTER, modifiers: META });
  b = await until((x) => /thinking · \d+ words/.test(x.aiFoot), 8000, "the thinking progress");
  check(true, `while Ultra streams, the panel says what it's doing: "${b.aiFoot}"`);
  await shot("2-ultra-thinking");
  b = await until((x) => x.answer.startsWith("Mock Ultra answer"), 20000, "Ultra's answer");
  check(/^Nemotron 3 Ultra · [\d.]+ s · thought [\d,]+ words$/.test(b.aiFoot), `the answer says Ultra and how much it thought: "${b.aiFoot}"`);
  check(/Ultra used this part/.test(b.status) && /1 of 2/.test(b.status), `the status line says Ultra used these parts: "${b.status}"`);
  const deepLit = await lit("ctrlf-match");
  check(/refitted with hybrid engines|built in 1998/.test(deepLit?.[0] ?? ""), "the lines Ultra used are highlighted", deepLit?.[0]);
  const deepReq = mock.requests.find((r) => r.kind === "deep");
  check(deepReq?.stream && deepReq?.thinking === true, "Ultra was asked to stream with reasoning on");
  await shot("2-ultra-answer");
  await key("ArrowDown", "ArrowDown", { windowsVirtualKeyCode: 40 });
  b = await until((x) => /2 of 2/.test(x.status), 4000, "the second line");
  check(true, "↓ steps to Ultra's second line");

  // ---------- 3. Option+Enter: compare runs Lightning ----------
  console.log("\n3. Option+Enter: compare");
  await type("when does the first boat leave on sunday");
  await key("Enter", "Enter", { ...ENTER, modifiers: ALT });
  b = await until((x) => x.compare && !/Asking both/.test(x.compare), 10000, "compare");
  check(/Lightning/.test(b.vs) && mock.requests.some((r) => r.kind === "compare"), `compare mode asked Lightning: "${b.compare}"`);

  // ---------- 4. Out of Nebius credit ----------
  console.log("\n4. Out of Nebius credit");
  await type("MOCK402 is there a lift");
  await key("Enter", "Enter", ENTER);
  b = await until((x) => /credit|funds/.test(x.status), 10000, "the out-of-credit message");
  check(/Nebius account is out of credit/.test(b.status) && !/Jev/.test(b.status), `the message blames Nebius, not Jev: "${b.status}"`);

  // ---------- 5. A Jev key Jev refuses → Lightning takes over ----------
  console.log("\n5. Jev refuses the key, Lightning takes over");
  await store({ ...NEBIUS, jevApiKey: "apikey_made_up_for_this_test" });
  await type("are assistance dogs allowed");
  await key("Enter", "Enter", ENTER);
  b = await until((x) => /Lightning/.test(x.status) || /Jev/.test(x.status), 20000, "the search");
  check(/Lightning · \d+ ms · Jev key refused/.test(b.status), `Lightning finds it and says Jev refused the key: "${b.status}"`);
  const dogs = await lit("ctrlf-match");
  check(dogs?.[0]?.startsWith("Both terminals have step-free ramps"), "…on the right paragraph", dogs?.[0]);

  // ---------- 6. The settings page checks the key ----------
  console.log("\n6. Settings: check the key");
  await store(NEBIUS);
  const { targetId: optId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/options.html` });
  const { sessionId: opt } = await send("Target.attachToTarget", { targetId: optId, flatten: true });
  await send("Runtime.enable", {}, opt);
  await sleep(800);
  const nebiusState = await evaluate(`document.getElementById("nebius-state").textContent`, opt);
  check(/A Nebius key is saved/.test(nebiusState), `the Nebius card says a key is saved: "${nebiusState}"`);
  const provider = await evaluate(`document.querySelector("input[name=provider]:checked")?.value`, opt);
  check(provider === "nemotron", `answers default to Nemotron (${provider})`);
  const hostedHidden = await evaluate(`document.getElementById("hosted-card").hidden`, opt);
  check(hostedHidden === true, "the hosted AI key card is hidden while Nemotron is picked");
  await evaluate(`document.getElementById("check-nebius").click(), "clicked"`, opt);
  let checked = "";
  for (let i = 0; i < 40 && !/✓|✗|didn't|Couldn't/.test(checked); i++) {
    await sleep(150);
    checked = await evaluate(`document.getElementById("nebius-check-state").textContent`, opt);
  }
  check(/Lightning ✓\s+Super ✓\s+Ultra ✓/.test(checked), `Check the key lists all three models: "${checked}"`);
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1400, deviceScaleFactor: 1, mobile: false }, opt);
  await evaluate(`document.getElementById("check-nebius").scrollIntoView({ block: "center" }), "ok"`, opt);
  await shot("6-settings-nebius", opt);
} catch (err) {
  failures++;
  console.log(`✗ ${err.message}`);
} finally {
  for (const p of problems) console.log(`page error: ${p}`);
  if (problems.length) failures++;
  chrome.kill();
  await mock.close();
  await sleep(300);
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : "All passed"} — ${checks} checks against the stand-in Nebius. Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
