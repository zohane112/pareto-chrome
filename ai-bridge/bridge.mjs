// Local AI bridge for Ctrl+F by meaning: a Chrome native messaging host.
//
// Chrome starts this program when the extension asks an AI for a written answer. It runs
// the AI command-line tools installed on this Mac: agy first, then grok, then codex, and
// returns the first answer that comes back. It stands in for the API a released product
// would call.
//
// Page text reaches the tools, so each one runs locked down: sandboxed, no web search or
// helpers, in a fresh empty folder that is deleted afterwards. The prompt also tells the
// model to treat page text as data.
//
// Messages (Chrome's format: 4-byte length, then JSON):
//   { type: "ping" }                     → { ok: true, tools: { agy: true, grok: false, … } }
//   { type: "ask", prompt, order?, timeoutMs? } → { ok, text, tool, ms, tried: [{ tool, ok, ms, error? }] }
// Nothing else may be written to stdout, since Chrome reads it as messages.

import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const VERSION = "1.0.0";
const ORDER = ["agy", "grok", "codex"];
const TIMEOUT_MS = 45000; // per tool

// Chrome starts native hosts with a bare PATH; look where these tools usually live.
const HOME = homedir();
const DIRS = [...new Set([
  `${HOME}/.local/bin`, `${HOME}/.grok/bin`, `${HOME}/bin`, "/opt/homebrew/bin", "/usr/local/bin",
  ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
])];
const env = { ...process.env, PATH: DIRS.join(delimiter), NO_COLOR: "1", TERM: "dumb" };

function which(cmd) {
  for (const dir of DIRS) {
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return join(dir, cmd);
    } catch {}
  }
  return null;
}

// How to run each tool for one answer, with no way to act on the machine.
const TOOLS = {
  agy: (prompt) => ({
    args: ["-p", prompt, "--sandbox", "--disable-slash-commands", "--model", "gemini-3.8-flash-low", "--print-timeout", "45s"],
  }),
  grok: (prompt, dir) => ({
    args: ["-p", prompt, "--cwd", dir, "--no-subagents", "--disable-web-search", "--max-turns", "1", "--permission-mode", "dontAsk"],
  }),
  codex: (prompt, dir) => ({
    args: [
      "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-C", dir,
      "-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="low"', "-o", join(dir, "answer.txt"), "-",
    ],
    stdin: prompt,
    outFile: join(dir, "answer.txt"),
  }),
};

const plain = (text) => text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "").trim();

function run(tool, prompt, timeoutMs) {
  const started = Date.now();
  const done = (result) => ({ tool, ms: Date.now() - started, ...result });
  const path = which(tool);
  if (!path) return Promise.resolve(done({ ok: false, error: "not installed" }));
  const dir = mkdtempSync(join(tmpdir(), "ctrlf-ai-"));
  const spec = TOOLS[tool](prompt, dir);
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    const child = spawn(path, spec.args, { cwd: dir, env, stdio: [spec.stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin?.on("error", () => {});
    child.stdin?.end(spec.stdin);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve(done({ ok: false, error: e.message }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = out;
      if (spec.outFile) {
        try {
          text = readFileSync(spec.outFile, "utf8");
        } catch {
          text = "";
        }
      }
      rmSync(dir, { recursive: true, force: true });
      text = plain(text);
      if (timedOut) return resolve(done({ ok: false, error: `no answer within ${timeoutMs / 1000} s` }));
      if (code !== 0 || !text) {
        const why = plain(err || out).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 240);
        return resolve(done({ ok: false, error: why || `exited with code ${code}` }));
      }
      resolve(done({ ok: true, text }));
    });
  });
}

async function ask({ prompt, order = ORDER, timeoutMs = TIMEOUT_MS }) {
  const started = Date.now();
  const tried = [];
  for (const tool of order.filter((t) => TOOLS[t])) {
    const result = await run(tool, prompt, timeoutMs);
    tried.push({ tool, ok: result.ok, ms: result.ms, ...(result.error && { error: result.error }) });
    if (result.ok) return { ok: true, text: result.text, tool, ms: Date.now() - started, tried };
  }
  return { ok: false, ms: Date.now() - started, tried };
}

async function handle(message) {
  if (message?.type === "ping") {
    return { ok: true, version: VERSION, tools: Object.fromEntries(ORDER.map((t) => [t, !!which(t)])) };
  }
  if (message?.type === "ask" && typeof message.prompt === "string") return ask(message);
  return { ok: false, error: "unknown message" };
}

// Chrome's native messaging format.
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE(0);
    if (buffer.length < 4 + size) break;
    const raw = buffer.subarray(4, 4 + size).toString("utf8");
    buffer = buffer.subarray(4 + size);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      send({ ok: false, error: "bad message" });
      continue;
    }
    handle(message).then((reply) => send({ ...reply, id: message.id }), (e) => send({ ok: false, error: e.message, id: message.id }));
  }
});
process.stdin.on("end", () => process.exit(0));
