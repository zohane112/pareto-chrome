// Runs the real extension on many kinds of website in a hidden, throwaway Chrome, to catch
// pages where it breaks. For each site it opens the box, checks the page was read, types a
// word (it should light up before Enter), and asks one question by meaning with real Jev.
// It fails on any error thrown by the extension's own scripts.
//
//   CTRLF_TMP=<scratch folder> node tests/sites-check.mjs [--no-jev] [--only mdn,github]
//
// The Jev key comes from the macOS Keychain (typesafe-jev) and is never printed. Jev calls
// are logged in spend.md.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEND = join(ROOT, ".scratch/ctrl-f-by-meaning/spend.md");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SCRATCH = process.env.CTRLF_TMP || tmpdir();
const TMP = mkdtempSync(join(SCRATCH, "ctrlf-sites-"));
const SHOTS = join(SCRATCH, "sites-shots");
const args = process.argv.slice(2);
const noJev = args.includes("--no-jev");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;

// Each site: a word to type (it should be on the page) and a question whose answer holds `expect`.
const SITES = [
  { name: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies", word: "cookie",
    q: "how do I stop javascript from reading a cookie", expect: /httponly/i },
  { name: "wikipedia", url: "https://en.wikipedia.org/wiki/Python_(programming_language)", word: "Guido",
    q: "who created python", expect: /guido|van rossum/i },
  { name: "github", url: "https://github.com/microsoft/vscode", word: "Code",
    q: "how do I contribute", expect: /contribut/i },
  { name: "terms", url: "https://policies.google.com/terms?hl=en", word: "Google",
    q: "can they suspend my account", expect: /suspend|terminat|disable/i },
  { name: "python-docs", url: "https://docs.python.org/3/tutorial/controlflow.html", word: "range",
    q: "how do I loop over a sequence of numbers", expect: /range/i },
  { name: "hn", url: "https://news.ycombinator.com/", word: "comments", q: null },
  { name: "gov-uk", url: "https://www.gov.uk/renew-driving-licence", word: "licence",
    q: "how much does it cost to renew", expect: /£|free|cost|fee|pay/i },
  { name: "apple", url: "https://www.apple.com/macbook-air/", word: "MacBook",
    q: "how long does the battery last", expect: /hour|battery/i },
  { name: "bbc", url: "https://www.bbc.com/news", word: "news", q: null },
  { name: "youtube", url: "https://www.youtube.com/results?search_query=peptides", word: "peptide",
    q: "which video is about peptides", expect: /peptide/i },
].filter((s) => !only || only.includes(s.name));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = noJev ? null : execFileSync("security", ["find-generic-password", "-s", "typesafe-jev", "-w"]).toString().trim();

const EXT = join(TMP, "extension");
cpSync(join(ROOT, "extension"), EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>"); // the worker opens the box itself: no key press, no activeTab
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));
const PROFILE = join(TMP, "profile");
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`, "--headless", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank",
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
const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
async function evaluate(expression, sessionId) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
function waitLog(sessionId, prefix, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { listeners.delete(l); resolve(null); }, ms);
    const l = (m) => {
      if (m.sessionId === sessionId && m.method === "Runtime.consoleAPICalled" && String(m.params.args[0]?.value).startsWith(prefix)) {
        clearTimeout(timer); listeners.delete(l); resolve(String(m.params.args[0].value));
      }
    };
    listeners.add(l);
  });
}

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "✓" : "✗"} ${label}`); return ok; };
let tokens = 0;

try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  let worker;
  for (let i = 0; i < 50 && !worker; i++) {
    const { targetInfos } = await send("Target.getTargets");
    worker = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!worker) await sleep(200);
  }
  const { sessionId: sw } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  if (KEY) {
    const { result: global } = await send("Runtime.evaluate", { expression: "globalThis" }, sw);
    await send("Runtime.callFunctionOn", {
      objectId: global.objectId, awaitPromise: true, returnByValue: true,
      functionDeclaration: "function (key) { return chrome.storage.local.set({ jevApiKey: key, aiAuto: false, aiProvider: 'off', plan: 'ai' }).then(() => 'saved'); }",
      arguments: [{ value: KEY }],
    }, sw);
    await evaluate(`globalThis.__jevTokens = 0; const realFetch = fetch; globalThis.fetch = async (...a) => { const r = await realFetch(...a); if (r.ok && String(a[0]).includes("typesafe")) r.clone().json().then((j) => { globalThis.__jevTokens += j.usage?.input_tokens ?? 0; }).catch(() => {}); return r; }; "ok"`, sw);
  } else {
    await evaluate(`chrome.storage.local.set({ plan: 'free' }).then(() => "ok")`, sw);
  }

  for (const site of SITES) {
    console.log(`\n— ${site.name}: ${site.url}`);
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
    const errors = [];
    const onMsg = (m) => {
      if (m.sessionId !== page || m.method !== "Runtime.exceptionThrown") return;
      const d = m.params.exceptionDetails;
      const text = `${d.exception?.description ?? d.text} ${d.url ?? ""} ${d.stackTrace?.callFrames?.map((f) => f.url).join(" ") ?? ""}`;
      if (text.includes("chrome-extension://")) errors.push(text.slice(0, 300));
    };
    listeners.add(onMsg);
    try {
      await send("Page.enable", {}, page);
      await send("Runtime.enable", {}, page);
      await send("Emulation.setFocusEmulationEnabled", { enabled: true }, page);
      await send("Page.bringToFront", {}, page);
      const loaded = new Promise((resolve) => {
        const t = setTimeout(resolve, 25000);
        const l = (m) => { if (m.sessionId === page && m.method === "Page.loadEventFired") { clearTimeout(t); listeners.delete(l); resolve(); } };
        listeners.add(l);
      });
      await send("Page.navigate", { url: site.url }, page);
      await loaded;
      await sleep(1500);

      const read = waitLog(page, "Pareto read", 8000);
      const here = await evaluate("location.href", page);
      const opened = await evaluate(`chrome.tabs.query({}).then((tabs) => { const t = tabs.find((x) => (x.url ?? x.pendingUrl ?? "") === ${JSON.stringify(here)}) ?? tabs.find((x) => x.active); return t ? openBox(t).then(() => "ok") : "no tab"; })`, sw);
      const readLine = await read;
      const box = await evaluate(`!!document.getElementById("ctrlf-by-meaning")`, page);
      const chunks = Number(readLine?.match(/read (\d+) chunks/)?.[1] ?? 0);
      check(opened === "ok" && box, `box opens`);
      check(chunks > 3, `page read: ${readLine ?? "no read line"}`);

      await send("Input.insertText", { text: site.word }, page);
      await sleep(400);
      const lit = await evaluate(`CSS.highlights.get("ctrlf-word")?.size ?? 0`, page);
      check(lit > 0, `typing "${site.word}" lights up ${lit} word matches`);

      if (site.q && KEY) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"] }, page);
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 }, page);
        await send("Input.insertText", { text: site.q }, page);
        const searched = waitLog(page, `Pareto: "${site.q}"`, 20000);
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, page);
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, page);
        const line = await searched;
        await sleep(1500);
        const para = await evaluate(`(() => { const h = CSS.highlights.get("ctrlf-match"); return h ? [...h].map((r) => r.toString()).join(" ").replace(/\\s+/g, " ").slice(0, 400) : ""; })()`, page);
        const ms = line?.match(/Enter to highlight (\d+) ms/)?.[1];
        check(!!para && site.expect.test(para), `"${site.q}" → ${ms ?? "?"} ms: "${para.slice(0, 140)}…"`);
      }
      mkdirSync(SHOTS, { recursive: true });
      const { data } = await send("Page.captureScreenshot", { format: "png" }, page);
      writeFileSync(join(SHOTS, `${site.name}.png`), Buffer.from(data, "base64"));
      check(errors.length === 0, `no errors from the extension${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    } catch (err) {
      check(false, `${site.name}: ${err.message}`);
    } finally {
      listeners.delete(onMsg);
      await send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }
  if (KEY) tokens = await evaluate("globalThis.__jevTokens", sw);
} catch (err) {
  check(false, err.message);
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true });
}

if (tokens) {
  const cost = tokens * 0.042 / 1e6;
  const log = readFileSync(SPEND, "utf8").trimEnd().split("\n");
  const before = Number(log.at(-1).split("|").map((s) => s.trim())[5]?.replace("$", "")) || 0;
  appendFileSync(SPEND, `| ${new Date().toLocaleDateString("en-CA")} | Sites check (tests/sites-check.mjs), ${SITES.filter((s) => s.q).length} questions | ${tokens} | $${cost.toFixed(6)} | $${(before + cost).toFixed(6)} |\n`);
  console.log(`\n${tokens} Jev input tokens, $${cost.toFixed(4)}. Running total $${(before + cost).toFixed(4)}.`);
}
console.log(`Screenshots: ${SHOTS}`);
console.log(failures ? `${failures} FAILED` : "All passed");
process.exit(failures ? 1 : 0);
