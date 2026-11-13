// Checks extension/scorer.js outside Chrome, with the key from the macOS Keychain
// (typesafe-jev, never printed). Real Jev calls are logged in spend.md.
//
//   node tests/scorer-check.mjs
//
// 1. The 10 test questions on the saved test page (one call each).
// 2. A padded page that forces the split path: the test page between two copies of itself
//    with the accepted paragraphs removed, so each answer exists in one window only.
// 3. Error handling with a stand-in fetch: no key, bad key, 429/529 retries, offline,
//    timeout, too big. No Jev calls except the bad-key one, which Jev refuses for free.

import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEND = join(ROOT, ".scratch/ctrl-f-by-meaning/spend.md");
const PRICE_PER_TOKEN = 0.042 / 1e6;

createRequire(import.meta.url)(join(ROOT, "extension/scorer.js"));
const { score, ScoreError } = globalThis.CtrlF;

const { chunks } = JSON.parse(readFileSync(join(ROOT, "tests/ai-chunks.json"), "utf8"));
const KEY = execFileSync("security", ["find-generic-password", "-s", "typesafe-jev", "-w"]).toString().trim();

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
for (const t of TESTS) {
  t.ids = t.accept.map((o) => chunks.find((c) => c.text.startsWith(o))?.id);
  if (t.ids.includes(undefined)) throw new Error(`Accepted paragraph missing from chunks: ${t.q}`);
}

const CUTOFF = 0.5; // "Not found" below this, from the prototype ticket
const hit = (t, r) => (t.ids.length ? r.exists >= CUTOFF && t.ids.includes(r.top[0]?.id) : r.exists < CUTOFF);
let tokens = 0;
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

// 1. The test page, one window.
console.log("1. Test page, one call per question");
const times = [];
for (const t of TESTS) {
  const r = await score(chunks, t.q, { key: KEY });
  tokens += r.tokens;
  times.push(r.ms);
  check(hit(t, r) && r.calls === 1, `${t.q}  exists ${r.exists.toFixed(2)}  top ${r.top[0].id}  ${r.ms} ms  ${r.model}`);
}
times.sort((a, b) => a - b);
console.log(`   median ${times[5 - 1] / 2 + times[5] / 2} ms, slowest ${times.at(-1)} ms\n`);

// 2. A page too big for one call.
console.log("2. Padded page, split into windows");
const answers = new Set(TESTS.flatMap((t) => t.ids));
const copy = (prefix) => chunks.filter((c) => !answers.has(c.id)).map((c) => ({ ...c, id: `${prefix}${c.id}` }));
const padded = [...copy("a"), ...chunks, ...copy("b")];
for (const t of [TESTS[0], TESTS[4], TESTS[8]]) {
  const r = await score(padded, t.q, { key: KEY });
  tokens += r.tokens;
  check(hit(t, r) && r.calls === 3, `${padded.length} chunks, ${r.calls} calls: ${t.q}  exists ${r.exists.toFixed(2)}  top ${r.top.map((x) => `${x.id} ${x.score.toFixed(2)}`).join(", ")}  ${r.ms} ms`);
}
console.log();

// 3. Errors.
console.log("3. Errors");
const code = async (promise) => promise.then(() => "no error", (e) => (e instanceof ScoreError ? e.code : `other: ${e.message}`));
check((await code(score(chunks, "x", { key: "" }))) === "no-key", "no key saved → no-key");
check((await code(score(chunks.slice(0, 3), "x", { key: "not-a-real-key" }))) === "bad-key", "wrong key → bad-key (real Jev, refused)");
const huge = Array.from({ length: 10 }, (_, i) => chunks.map((c) => ({ ...c, id: `p${i}${c.id}` }))).flat();
check((await code(score(huge, "x", { key: KEY }))) === "too-big", `${huge.length} chunks → too-big, before any call`);

const realFetch = globalThis.fetch;
const fake = (statuses) => {
  let n = 0;
  globalThis.fetch = async () => {
    const s = statuses[Math.min(n++, statuses.length - 1)];
    if (s === "offline") throw new TypeError("fetch failed");
    if (s === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    if (s !== 200) return new Response("{}", { status: s, headers: { "retry-after-ms": "10" } });
    return Response.json({ model: "fake", usage: { input_tokens: 0 }, answers: { where: { probabilities: { c1: 1 } }, exists: { noul: 0.9 } } });
  };
  return () => n;
};
let calls = fake([429, 529, 200]);
check((await code(score(chunks.slice(0, 1), "x", { key: "k" }))) === "no error" && calls() === 3, "429, then 529, then OK → succeeds on the 3rd try");
calls = fake([429]);
check((await code(score(chunks.slice(0, 1), "x", { key: "k" }))) === "busy" && calls() === 4, "429 every time → busy after 3 retries");
calls = fake([500, 200]);
check((await code(score(chunks.slice(0, 1), "x", { key: "k" }))) === "no error" && calls() === 2, "500 once → retried");
fake([422]);
check((await code(score(chunks.slice(0, 1), "x", { key: "k" }))) === "jev-error", "422 → jev-error, no retry");
fake(["offline"]);
check((await code(score(chunks.slice(0, 1), "x", { key: "k" }))) === "offline", "network down → offline");
fake(["timeout"]);
check((await code(score(chunks.slice(0, 1), "x", { key: "k" }))) === "timeout", "no answer in 15 s → timeout");
globalThis.fetch = realFetch;

// Add this run to the spend log.
const cost = tokens * PRICE_PER_TOKEN;
const log = readFileSync(SPEND, "utf8").trimEnd().split("\n");
const before = Number(log.at(-1).split("|").map((s) => s.trim())[5]?.replace("$", "")) || 0;
const date = new Date().toLocaleDateString("en-CA");
appendFileSync(SPEND, `| ${date} | Scorer check (tests/scorer-check.mjs), 13 searches | ${tokens} | $${cost.toFixed(6)} | $${(before + cost).toFixed(6)} |\n`);
console.log(`\n${failures ? `${failures} FAILED` : "All passed"}. ${tokens} input tokens, $${cost.toFixed(4)}. Running total $${(before + cost).toFixed(4)}.`);
process.exit(failures ? 1 : 0);
