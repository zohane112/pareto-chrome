// Measures how fast the box appears, in a hidden, throwaway Chrome. No Jev calls, so it's free.
//
//   CTRLF_TMP=<scratch folder> node tests/launch-check.mjs [--page <url>] [--runs 5]
//
// Two ways in, each timed from the moment it's triggered until the box is on the page:
//   - worker: the background worker's openBox(tab), which the shortcut and toolbar button call
//   - keys:   Control+Shift+F pressed in the page (only works when the extension is preloaded)
// It also opens the box in a tab that was already open before the extension loaded, which is
// what happens right after an install or a reload. Then it checks, still without Jev:
//   - typing lights up word matches before Enter, like normal Ctrl+F
//   - with no key, Enter steps through word matches, and the worker refuses to ask Jev

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PAGE = opt("--page", "https://en.wikipedia.org/w/index.php?title=Artificial_intelligence&oldid=1376335904");
const RUNS = Number(opt("--runs", 5));
const TMP = mkdtempSync(join(process.env.CTRLF_TMP || tmpdir(), "ctrlf-launch-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A copy of the extension. Like chrome-check, it gets host permission for the test page,
// because the worker is called directly and there's no real key press to grant activeTab.
const EXT = join(TMP, "extension");
cpSync(join(ROOT, "extension"), EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
manifest.host_permissions.push(new URL(PAGE).origin + "/*");
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));
const PROFILE = join(TMP, "profile");
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`, "--headless", "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,900", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

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
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression, sessionId) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function openPage(url) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  const loaded = new Promise((resolve) => {
    const l = (m) => { if (m.sessionId === sessionId && m.method === "Page.loadEventFired") { listeners.delete(l); resolve(); } };
    listeners.add(l);
  });
  await send("Page.navigate", { url }, sessionId);
  await loaded;
  await sleep(500); // let preloaded scripts finish
  return { targetId, sessionId };
}

// Resolves with the milliseconds from trigger() until the box is in the page.
async function time(sessionId, trigger) {
  await evaluate(`window.__boxAt = null; new MutationObserver((_, o) => { if (document.getElementById("ctrlf-by-meaning")) { window.__boxAt = Date.now(); o.disconnect(); } }).observe(document.documentElement, { childList: true }); "ok"`, sessionId);
  const started = Date.now();
  await trigger();
  for (let i = 0; i < 100; i++) {
    const at = await evaluate("window.__boxAt", sessionId);
    if (at) return at - started;
    await sleep(20);
  }
  return null;
}
async function closeBox(sessionId) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await sleep(150);
}
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const show = (xs) => (xs.every((x) => x == null) ? "didn't open" : `median ${median(xs)} ms (${xs.map((x) => x ?? "✗").join(", ")})`);

try {
  // A tab that's open before the extension loads, like after an install or reload.
  const BEFORE = `${PAGE}#opened-before`;
  const before = await openPage(BEFORE);

  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  let worker;
  for (let i = 0; i < 50 && !worker; i++) {
    const { targetInfos } = await send("Target.getTargets");
    worker = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!worker) await sleep(200);
  }
  const { sessionId: sw } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const viaWorker = (url) => () => evaluate(`chrome.tabs.query({}).then((tabs) => openBox(tabs.find((t) => t.url === ${JSON.stringify(url)}))).then(() => "ok")`, sw);

  const page = await openPage(PAGE);
  const w = [];
  const k = [];
  for (let i = 0; i < RUNS; i++) {
    w.push(await time(page.sessionId, viaWorker(PAGE)));
    await closeBox(page.sessionId);
    k.push(await time(page.sessionId, async () => {
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 10 }, page.sessionId);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "F", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 10 }, page.sessionId);
    }));
    await closeBox(page.sessionId);
  }
  console.log(`Page: ${PAGE}`);
  console.log(`Shortcut through the worker: ${show(w)}`);
  console.log(`Control+Shift+F in the page:  ${show(k)}`);

  await send("Target.activateTarget", { targetId: before.targetId });
  const old = await time(before.sessionId, viaWorker(BEFORE));
  console.log(`Tab opened before the extension loaded: ${old == null ? "didn't open" : `${old} ms`}`);

  // Typing, and no key saved.
  let failures = 0;
  const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "✓" : "✗"} ${label}`); };
  const lit = (name) => evaluate(`CSS.highlights.get(${JSON.stringify(name)})?.size ?? 0`, page.sessionId);
  const enter = async () => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, page.sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, page.sessionId);
    await sleep(150);
  };
  await send("Target.activateTarget", { targetId: page.targetId });
  await time(page.sessionId, viaWorker(PAGE));
  await send("Input.insertText", { text: "Kasparov" }, page.sessionId);
  await sleep(200);
  check(await lit("ctrlf-word") > 0 && await lit("ctrlf-word-now") === 1, `typing "Kasparov" lights up ${await lit("ctrlf-word")} matches before Enter`);
  await closeBox(page.sessionId);

  await evaluate(`chrome.storage.local.remove(["jevApiKey", "nebiusApiKey"]).then(() => "ok")`, sw);
  await time(page.sessionId, viaWorker(PAGE));
  await sleep(100);
  await send("Input.insertText", { text: "Kasparov" }, page.sessionId);
  await sleep(200);
  const firstNow = await evaluate(`[...CSS.highlights.get("ctrlf-word-now")][0].getBoundingClientRect().top + scrollY`, page.sessionId);
  await enter();
  const secondNow = await evaluate(`[...CSS.highlights.get("ctrlf-word-now")][0].getBoundingClientRect().top + scrollY`, page.sessionId);
  check(firstNow !== secondNow && await lit("ctrlf-match") === 0, "no key: Enter steps to the next word match, with no meaning search");
  const refused = await evaluate(`HANDLERS.search({ question: "x", chunks: [] }).then(() => "allowed", (e) => e.code)`, sw);
  check(refused === "free-plan", `no key: the worker refuses to ask Jev (${refused})`);
  await closeBox(page.sessionId);
  if (failures) process.exitCode = 1;
} catch (err) {
  console.log(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(TMP, { recursive: true, force: true });
}
