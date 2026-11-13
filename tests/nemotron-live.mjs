// Checks the Nemotron paths against the real Nebius Token Factory, with the key from the macOS
// Keychain (nebius-tokenfactory, never printed). It spends a few cents of Nebius credit, and
// logs the tokens in .scratch/ctrl-f-by-meaning/nebius-spend.md.
//
//   node tests/nemotron-live.mjs [--jev]
//
// To save the key in the Keychain once (it asks for the key, so it isn't in your shell history):
//   security add-generic-password -s nebius-tokenfactory -a pareto -w
//
// 0. Which Nemotron models the key can use, on both Token Factory hosts, and whether the three
//    ids Pareto uses are among them. If one isn't, it stops here and lists the near matches.
// 1. Lightning finds the answer to the 10 test questions on the saved test page: hits and time.
// 2. Super writes two answers from the accepted paragraphs.
// 3. Ultra thinks harder about one question over the whole page, with progress as it streams.
// --jev also times Jev on the same 10 questions, for compare mode's numbers (uses Jev credit).

import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEND = join(ROOT, ".scratch/ctrl-f-by-meaning/nebius-spend.md");
const require = createRequire(import.meta.url);

// Prices per million tokens, input and output. Lightning's is from a third-party listing and
// Ultra's from Nebius's cookbook; Super's wasn't found. Check the Nebius billing page for the
// real figures.
const PRICES = { Lightning: [0.06, 0.24], Ultra: [1, 3] };

let KEY;
try {
  KEY = execFileSync("security", ["find-generic-password", "-s", "nebius-tokenfactory", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  console.log("No Nebius key in the Keychain yet. Save it once with:\n\n  security add-generic-password -s nebius-tokenfactory -a pareto -w\n\nIt asks for the key, then run this again.");
  process.exit(1);
}

// Count every Token Factory call's tokens and status, by model.
const used = {};
const statuses = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const res = await realFetch(url, init);
  const model = init.body ? JSON.parse(init.body).model : null;
  statuses.push({ url: String(url).replace(/^https:\/\//, ""), model, status: res.status });
  if (res.ok && model && !JSON.parse(init.body).stream) {
    res.clone().json().then((j) => {
      const u = (used[model] ??= { in: 0, out: 0, calls: 0 });
      u.in += j.usage?.prompt_tokens ?? 0;
      u.out += j.usage?.completion_tokens ?? 0;
      u.calls++;
    }).catch(() => {});
  }
  return res;
};

for (const f of ["net.js", "scorer.js", "nemotron.js", "ai.js", "compare.js"]) require(join(ROOT, "extension", f));
const C = globalThis.CtrlF;
const N = C.nemotron;
const settings = { nebiusApiKey: KEY };

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  return ok;
};

// ---------- 0. Models ----------
console.log("0. Models on Token Factory");
const HOSTS = ["https://api.tokenfactory.us-central1.nebius.com/v1", "https://api.tokenfactory.nebius.com/v1"];
const listed = {};
for (const host of HOSTS) {
  try {
    const res = await realFetch(`${host}/models`, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.log(`  ${host}: HTTP ${res.status}`);
      continue;
    }
    listed[host] = ((await res.json()).data ?? []).map((m) => m.id);
    const nemotrons = listed[host].filter((id) => /nemotron/i.test(id));
    console.log(`  ${host}: ${listed[host].length} models, Nemotron: ${nemotrons.join(", ") || "none"}`);
  } catch (err) {
    console.log(`  ${host}: ${err.message}`);
  }
}
const ours = N.DEFAULTS;
const onDefault = new Set((listed[ours.baseUrl] ?? []).map((id) => id.toLowerCase()));
const missing = ["fast", "answer", "deep"].filter((tier) => !onDefault.has(ours[tier].toLowerCase()));
for (const tier of ["fast", "answer", "deep"]) check(!missing.includes(tier), `${N.NAMES[tier]}: ${ours[tier]} is listed on ${ours.baseUrl}`);
if (missing.length) {
  console.log("\nStopping: fix the model ids in extension/nemotron.js (DEFAULTS) and options.js (NEBIUS_DEFAULTS) first.");
  process.exit(1);
}

// ---------- 1. Lightning finds ----------
const { chunks } = JSON.parse(readFileSync(join(ROOT, "tests/ai-chunks.json"), "utf8"));
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
for (const t of TESTS) t.ids = t.accept.map((o) => chunks.find((c) => c.text.startsWith(o))?.id);
const hit = (t, r) => (t.ids.length ? r.exists >= 0.5 && t.ids.includes(r.top[0]?.id) : r.exists < 0.5);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

console.log(`\n1. Lightning finds the answer (${chunks.length} paragraphs, one call each)`);
const lightningMs = [];
let lightningHits = 0;
for (const t of TESTS) {
  try {
    const r = await N.find(chunks, t.q, settings);
    lightningMs.push(r.ms);
    const ok = hit(t, r);
    if (ok) lightningHits++;
    console.log(`${ok ? "✓" : "✗"} ${t.q}  sure ${r.exists.toFixed(2)}  top ${r.top.map((x) => x.id).join(",") || "-"}  ${r.ms} ms`);
  } catch (err) {
    failures++;
    console.log(`✗ ${t.q}  ${err.code}: ${err.message}`);
  }
}
console.log(`   ${lightningHits}/10 right, median ${median(lightningMs)} ms, slowest ${Math.max(...lightningMs)} ms`);
check(lightningHits >= 8, "Lightning gets at least 8 of the 10 right (Jev got 10/10)");

if (process.argv.includes("--jev")) {
  console.log("\n   Jev on the same questions, for compare mode");
  try {
    const jevKey = execFileSync("security", ["find-generic-password", "-s", "typesafe-jev", "-w"]).toString().trim();
    const jevMs = [];
    let jevHits = 0;
    for (const t of TESTS) {
      const r = await C.score(chunks, t.q, { key: jevKey });
      jevMs.push(r.ms);
      if (hit(t, r)) jevHits++;
    }
    console.log(`   Jev: ${jevHits}/10 right, median ${median(jevMs)} ms. Jev is ${(median(lightningMs) / median(jevMs)).toFixed(1)}× faster.`);
  } catch (err) {
    console.log(`   Jev didn't run: ${err.code ?? ""} ${err.message}`);
  }
}

// ---------- 2. Super answers ----------
console.log("\n2. Super writes the answer");
for (const t of [TESTS[0], TESTS[5]]) {
  try {
    const excerpts = t.ids.map((id) => chunks.find((c) => c.id === id)).map((c) => ({ text: c.text, path: c.path }));
    const r = await C.askAI({ question: t.q, title: "Artificial intelligence - Wikipedia", url: "https://en.wikipedia.org/wiki/Artificial_intelligence", excerpts }, settings);
    check(r.provider === "nemotron" && r.text.length > 20, `${t.q}  (${r.by}, ${r.ms} ms)\n     ${r.text}`);
  } catch (err) {
    check(false, `${t.q}  ${err.code}: ${err.message}`);
  }
}

// ---------- 3. Ultra thinks harder ----------
console.log("\n3. Ultra thinks harder over the whole page");
{
  const q = "how have people worried that AI could be dangerous, and what has been done about it?";
  let last = "";
  const started = Date.now();
  try {
    const r = await N.thinkHarder({ question: q, title: "Artificial intelligence - Wikipedia", url: "https://en.wikipedia.org/wiki/Artificial_intelligence", chunks }, settings, {
      onProgress: (p) => {
        const now = `${p.phase} ${Math.round(p.thoughtChars / 6)} words`;
        if (now.split(" ")[0] !== last.split(" ")[0]) console.log(`   ${((Date.now() - started) / 1000).toFixed(1)} s: ${p.phase}`);
        last = now;
      },
    });
    const u = (used[r.by] ??= { in: 0, out: 0, calls: 0 });
    u.calls++;
    u.tokens = r.tokens;
    check(r.text.length > 40 && r.lines.length > 0, `${q}\n     ${r.text}\n     lines ${r.lines.join(", ")}, ${r.ms} ms, thought ${Math.round(r.thoughtChars / 6)} words, ${r.tokens} tokens`);
  } catch (err) {
    check(false, `${q}  ${err.code}: ${err.message}`);
  }
}

// Requests that had to be repeated without an optional field show up as a 400 then a 200.
const refused = statuses.filter((s) => s.status === 400);
if (refused.length) console.log(`\nNote: ${refused.length} request(s) got HTTP 400 and were retried without chat_template_kwargs or response_format.`);

// ---------- Spend log ----------
const date = new Date().toLocaleDateString("en-CA");
if (!existsSync(SPEND)) {
  writeFileSync(SPEND, "# Nebius Token Factory spending (Nemotron)\n\nTokens per run, from Token Factory's usage counts. Costs are estimates; the Nebius billing page has the real figures.\n\n| Date | What | Model | Calls | Tokens | Estimated cost |\n| --- | --- | --- | --- | --- | --- |\n");
}
let total = 0;
for (const [model, u] of Object.entries(used)) {
  const short = /Lightning/i.test(model) ? "Lightning" : /Ultra/i.test(model) ? "Ultra" : /super/i.test(model) ? "Super" : model;
  const tokens = u.tokens ?? u.in + u.out;
  const price = PRICES[short];
  const cost = price ? (u.tokens ? u.tokens * price[0] : u.in * price[0] + u.out * price[1]) / 1e6 : null;
  if (cost) total += cost;
  appendFileSync(SPEND, `| ${date} | Live check (tests/nemotron-live.mjs) | ${short} | ${u.calls} | ${tokens} | ${cost == null ? "price not checked" : `$${cost.toFixed(4)}`} |\n`);
}
console.log(`\n${failures ? `${failures} FAILED` : "All passed"}. About $${total.toFixed(3)} of Nebius credit (Super not priced). Logged in ${SPEND.replace(ROOT + "/", "")}.`);
process.exit(failures ? 1 : 0);
