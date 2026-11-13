// Checks extension/nemotron.js, and how ai.js and compare.js use it, without Chrome, without a
// Nebius key, and without spending anything. Every call goes to a stubbed `fetch`.
//
//   node tests/nemotron-check.mjs
//
// What it covers:
//   - Lightning finding lines: the request it sends (model, no reasoning, JSON, the key) and
//     how it reads replies, including untidy ones
//   - Jev first: when Lightning takes over from Jev, and when a Jev failure goes through
//   - the sentence pick goes to the engine that found the paragraph
//   - Super for answers, Lightning for compare mode, and the fallbacks between providers
//   - Ultra's think-harder: a streamed reply with reasoning, progress as it streams, and the
//     ANSWER/LINES reply read back into an answer and page lines
//   - a model that refuses an optional field (chat_template_kwargs) is asked again without it
//   - the key check lists which of the three models the key can use
//
// It does NOT prove Nebius serves these models or how fast they are: for that, run
// tests/nemotron-live.mjs with a real key.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");
const FILES = ["net.js", "scorer.js", "nemotron.js", "ai.js", "compare.js"];

let failures = 0;
let checks = 0;
function check(ok, label, extra = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${extra && !ok ? ` — ${extra}` : ""}`);
}
const eq = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);

function load(fakeFetch) {
  const sandbox = {
    console, performance, setTimeout, clearTimeout, TextDecoder, TextEncoder,
    AbortSignal: { timeout: () => ({}) },
    fetch: fakeFetch,
    chrome: { runtime: { connectNative: () => { throw new Error("no bridge"); }, lastError: null } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(readFileSync(join(EXT, f), "utf8"), sandbox, { filename: f });
  return sandbox.CtrlF;
}

const reply = (status, body = "", headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  json: async () => (typeof body === "string" ? JSON.parse(body || "{}") : body),
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const chat = (content, extra = {}) => reply(200, { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 }, ...extra });

// A streamed reply: server-sent events, split at awkward places like a real network would.
function streamed(events) {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 37) pieces.push(bytes.slice(i, i + 37));
  return {
    ...reply(200),
    body: { getReader: () => ({ read: async () => (pieces.length ? { value: pieces.shift(), done: false } : { done: true }) }) },
  };
}
const delta = (d, finish = null) => ({ choices: [{ delta: d, finish_reason: finish }] });

const CHUNKS = [
  { id: "c1", text: "Pareto is a browser extension.", path: ["Intro"] },
  { id: "c2", text: "It costs nothing on the free plan.", path: ["Pricing"] },
  { id: "c3", text: "The AI plan finds answers by meaning.", path: ["Pricing"] },
  { id: "c4", text: "It was started in September 2026.", path: ["History"] },
];
const NEBIUS = { nebiusApiKey: "nebius-test-key" };

// ---------------------------------------------------------------- Lightning finds lines

console.log("Lightning finds the lines that answer");
{
  let sent;
  const C = load(async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return chat('{"answered": true, "sure": 92, "lines": ["c3", "c2", "c99"]}');
  });
  const out = await C.nemotron.find(CHUNKS, "what does the AI plan do?", NEBIUS);
  eq(sent.url, "https://api.tokenfactory.us-central1.nebius.com/v1/chat/completions", "posts to Token Factory's chat API");
  eq(sent.auth, "Bearer nebius-test-key", "…with the key it was handed");
  eq(sent.body.model, "nvidia/Nemotron-3_5-Lightning", "…asking Nemotron 3.5 Lightning");
  eq(sent.body.chat_template_kwargs, { enable_thinking: false }, "…with reasoning off, for speed");
  eq(sent.body.response_format, { type: "json_object" }, "…for a JSON reply");
  check(sent.body.messages[1].content.includes("c3| [Pricing] The AI plan"), "…sending each line with its id and section");
  eq(out.top.map((t) => t.id), ["c3", "c2"], "keeps the lines in its order and drops ids that aren't on the page");
  eq(out.exists, 0.92, "how sure it is becomes the meter");
  check(out.top[0].score > out.top[1].score, "the first line scores highest");
  eq([out.engine, out.by, out.short], ["nemotron", "Nemotron 3.5 Lightning", "Lightning"], "says Lightning found it");
}
{
  const C = load(async () => chat('<think>the pricing section</think>\nSure! Here it is: {"answered": true, "sure": 70, "lines": ["c2"]} hope that helps'));
  const out = await C.nemotron.find(CHUNKS, "is it free?", NEBIUS);
  eq(out.top.map((t) => t.id), ["c2"], "reads the JSON out of an untidy reply with thinking in it");
}
{
  const C = load(async () => chat("The answer is in line c4."));
  const out = await C.nemotron.find(CHUNKS, "when was it started?", NEBIUS);
  eq(out.top.map((t) => t.id), ["c4"], "a reply with no JSON still gives its line id");
  check(out.exists >= 0.5, "…and counts as answered");
}
{
  const C = load(async () => chat('{"answered": false, "sure": 90, "lines": []}'));
  const out = await C.nemotron.find(CHUNKS, "how do I cancel netflix?", NEBIUS);
  check(out.exists < 0.5 && out.exists <= 0.1 + 1e-9, "'not answered, 90 sure' means sure it isn't there", String(out.exists));
  eq(out.top, [], "…with no lines");
}
{
  const C = load(async () => chat("{}"));
  const big = [{ id: "c1", text: "x".repeat(2_100_000), path: [] }];
  const err = await C.nemotron.find(big, "q", NEBIUS).catch((e) => e);
  eq([err.code, err.service], ["too-big", "Nemotron"], "a page beyond what Lightning is sent → too-big, from Nemotron");
}
{
  const C = load(async () => chat("{}"));
  const err = await C.nemotron.find(CHUNKS, "q", {}).catch((e) => e);
  eq(err.code, "no-key", "no Nebius key → no-key, before any call");
}

// ---------------------------------------------------------------- a field the model refuses

console.log("\nA model that refuses an optional field");
{
  const bodies = [];
  const C = load(async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.chat_template_kwargs) return reply(400, '{"error": "Unknown field: chat_template_kwargs"}');
    return chat('{"answered": true, "sure": 80, "lines": ["c1"]}');
  });
  const first = await C.nemotron.find(CHUNKS, "what is it?", NEBIUS);
  eq(first.top[0].id, "c1", "a 400 naming chat_template_kwargs is retried without it, and works");
  eq(bodies.length, 2, "…in exactly one extra call");
  check("response_format" in bodies[1], "…keeping the fields it didn't object to");
  await C.nemotron.find(CHUNKS, "what is it?", NEBIUS);
  eq(bodies.length, 3, "later calls leave it out from the start");
  check(!("chat_template_kwargs" in bodies[2]), "…so there's no second refusal");
}
{
  let calls = 0;
  const C = load(async () => { calls++; return reply(400, "bad request: messages is empty"); });
  const err = await C.nemotron.find(CHUNKS, "q", NEBIUS).catch((e) => e);
  eq(err.code, "jev-error", "a 400 that's about something else still fails");
  eq(err.service, "Nemotron", "…and says Nemotron failed, so the box doesn't blame Jev");
  eq(calls, 2, "…after one try without the optional fields");
}

// ---------------------------------------------------------------- Jev first

console.log("\nJev first, Lightning when Jev can't");
const JEV_OK = { model: "jev-1.13.0", usage: { input_tokens: 1 }, answers: { where: { probabilities: { c1: 0.1, c2: 0.9 } }, exists: { noul: 0.95 } } };
function router(jev) {
  const hits = { jev: 0, nebius: 0 };
  const C = load(async (url) => {
    if (url.includes("typesafe")) { hits.jev++; return typeof jev === "function" ? jev() : jev; }
    hits.nebius++;
    return chat('{"answered": true, "sure": 88, "lines": ["c3"]}');
  });
  return { C, hits };
}
{
  const { C, hits } = router(reply(200, JEV_OK));
  const out = await C.nemotron.findAnswer(CHUNKS, "q", { jevApiKey: "j", ...NEBIUS });
  eq([out.engine, out.top[0].id, hits.nebius], ["jev", "c2", 0], "with a Jev key, Jev finds it and Nemotron isn't asked");
}
{
  const { C, hits } = router(reply(402, "out of funds"));
  const out = await C.nemotron.findAnswer(CHUNKS, "q", { jevApiKey: "j", ...NEBIUS });
  eq([out.engine, out.because, out.top[0].id], ["nemotron", "no-funds", "c3"], "Jev out of funds → Lightning takes over and says why");
  eq(hits.jev, 1, "…after one Jev call, no retries on a funds refusal");
}
for (const [status, code] of [[401, "bad-key"], [500, "jev-error"], [529, "busy"]]) {
  const { C } = router(reply(status, "x"));
  const out = await C.nemotron.findAnswer(CHUNKS, "q", { jevApiKey: "j", ...NEBIUS });
  eq(out.because, code, `Jev ${code} → Lightning`);
}
{
  const { C } = router(() => { throw Object.assign(new Error("Failed to fetch"), { name: "TypeError" }); });
  const err = await C.nemotron.findAnswer(CHUNKS, "q", { jevApiKey: "j", ...NEBIUS }).catch((e) => e);
  eq(err.code, "offline", "offline goes through: Nebius would be unreachable too");
}
{
  const { C } = router(reply(402, "out of funds"));
  const err = await C.nemotron.findAnswer(CHUNKS, "q", { jevApiKey: "j" }).catch((e) => e);
  eq(err.code, "no-funds", "Jev out of funds and no Nebius key → Jev's own error, as before");
}
{
  const { C, hits } = router(reply(200, JEV_OK));
  const out = await C.nemotron.findAnswer(CHUNKS, "q", NEBIUS);
  eq([out.engine, out.because, hits.jev], ["nemotron", undefined, 0], "only a Nebius key → Lightning finds it, Jev isn't tried");
}
{
  const { C } = router(reply(200, JEV_OK));
  const err = await C.nemotron.findAnswer(CHUNKS, "q", {}).catch((e) => e);
  eq(err.code, "no-key", "no keys at all → no-key");
}

console.log("\nThe sentence goes to the engine that found the paragraph");
{
  const hits = { jev: 0, nebius: 0 };
  const C = load(async (url) => {
    if (url.includes("typesafe")) { hits.jev++; return reply(200, { answers: { which: { choice: "s2", probabilities: { s2: 0.9 } } } }); }
    hits.nebius++;
    return chat('{"sentence": "s2"}');
  });
  const sentences = ["First.", "Second has the answer.", "Third."];
  const viaJev = await C.nemotron.findSentence(sentences, "q", { jevApiKey: "j", ...NEBIUS }, { engine: "jev" });
  eq([viaJev.index, hits.jev, hits.nebius], [1, 1, 0], "Jev found it → Jev picks the sentence");
  const viaNemo = await C.nemotron.findSentence(sentences, "q", { jevApiKey: "j", ...NEBIUS }, { engine: "nemotron" });
  eq([viaNemo.index, hits.jev, hits.nebius], [1, 1, 1], "Lightning found it → Lightning picks it, Jev isn't asked");
  const onlyNebius = await C.nemotron.findSentence(sentences, "q", NEBIUS, {});
  eq(onlyNebius.index, 1, "only a Nebius key → Lightning picks it");
}
{
  const C = load(async () => chat('{"sentence": "s9"}'));
  const out = await C.nemotron.pickSentence(["One.", "Two."], "q", NEBIUS);
  eq(out.index, 0, "an id that isn't a sentence falls back to the first");
}

// ---------------------------------------------------------------- answers and compare

console.log("\nSuper writes answers, Lightning races Jev in compare mode");
{
  const models = [];
  const C = load(async (url, init) => {
    const body = JSON.parse(init.body);
    models.push(body.model);
    return chat(body.model.includes("Lightning") ? '{"id": "c3", "answered": true}' : "The AI plan finds answers by meaning.");
  });
  const answer = await C.askAI({ question: "q", title: "T", url: "https://e.com", excerpts: [{ text: "x", path: [] }] }, NEBIUS);
  eq([answer.provider, answer.by, answer.short], ["nemotron", "Nemotron 3 Super", "Super"], "a fresh install's answers come from Nemotron 3 Super");
  eq(models.at(-1), "nvidia/nemotron-3-super-120b-a12b", "…asking the Super model id");
  const pick = await C.comparePick(CHUNKS, "q", NEBIUS);
  eq(models.at(-1), "nvidia/Nemotron-3_5-Lightning", "compare mode asks Lightning");
  eq([pick.id, pick.short], ["c3", "Lightning"], "…and the box gets its pick and short name");
}
{
  const C = load(async (url) => (url.includes("openai") ? chat("hosted says hi") : chat("nemotron says hi")));
  const out = await C.aiComplete("hi", { hostedApiKey: "h" });
  eq([out.provider, out.fellBackFrom], ["hosted", "nemotron"], "Nemotron with no Nebius key falls back to a saved hosted key");
  const err = await C.aiComplete("hi", {}).catch((e) => e);
  eq(err.code, "no-key", "…and with no keys at all, says no-key");
  const local = await C.aiComplete("hi", { aiProvider: "local", ...NEBIUS });
  eq([local.provider, local.fellBackFrom, local.text], ["nemotron", "local", "nemotron says hi"], "local with no helper installed falls back to Nemotron first");
}
{
  const C = load(async () => chat('{"model": "x"}', {}));
  const custom = await C.aiComplete("hi", { ...NEBIUS, nebiusAnswerModel: "nvidia/some-renamed-super" });
  eq(custom.by, "some-renamed-super", "a model id changed in settings is used and named by its id");
}

// ---------------------------------------------------------------- think harder

console.log("\nUltra thinks harder");
{
  let sent;
  const progress = [];
  const C = load(async (url, init) => {
    sent = JSON.parse(init.body);
    return streamed([
      delta({ role: "assistant" }),
      delta({ reasoning_content: "The question asks about pricing. " }),
      delta({ reasoning_content: "Lines c2 and c3 cover both plans." }),
      delta({ content: "ANSWER: The free plan costs nothing; the AI plan **finds answers** by meaning.\n" }),
      delta({ content: "LINES: c2, c3, c77" }, "stop"),
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 120 } },
      "[DONE]",
    ]);
  });
  const out = await C.nemotron.thinkHarder({ question: "what do the plans cost?", title: "Pareto", url: "https://e.com", chunks: CHUNKS }, NEBIUS, { onProgress: (p) => progress.push(p) });
  eq(sent.model, "nvidia/Nemotron-3-Ultra-550b-a55b", "asks Nemotron 3 Ultra");
  eq([sent.stream, sent.chat_template_kwargs], [true, { enable_thinking: true }], "…streamed, with reasoning on");
  check(sent.messages[0].content.includes("c4| [History] It was started"), "…sending the whole page, every line");
  eq(out.text, "The free plan costs nothing; the AI plan finds answers by meaning.", "reads the answer, without markdown");
  eq(out.lines, ["c2", "c3"], "reads the lines it used, dropping ids not on the page");
  eq([out.by, out.tokens], ["Nemotron 3 Ultra", 1020], "names Ultra and counts the tokens");
  check(out.thoughtChars > 50, "counts how much it thought", String(out.thoughtChars));
  check(progress.some((p) => p.phase === "thinking") && progress.at(-1).phase === "writing", "progress goes from thinking to writing", JSON.stringify(progress.map((p) => p.phase)));
}
{
  const C = load(async () => streamed([
    delta({ content: "<think>Let me look at the history" }),
    delta({ content: " section.</think>\n\nANSWER: It started in September 2026.\nLINES: none" }, "stop"),
    "[DONE]",
  ]));
  const out = await C.nemotron.thinkHarder({ question: "when?", title: "T", url: "u", chunks: CHUNKS }, NEBIUS);
  eq([out.text, out.lines], ["It started in September 2026.", []], "thinking inside <think> tags is left out of the answer; LINES: none → no lines");
}
{
  const C = load(async () => streamed([delta({ reasoning_content: "hmm ".repeat(50) }), delta({}, "length"), "[DONE]"]));
  const err = await C.nemotron.thinkHarder({ question: "q", title: "T", url: "u", chunks: CHUNKS }, NEBIUS).catch((e) => e);
  eq([err.code, err.name], ["api-error", "AiError"], "thinking that runs out of room with no answer is an error, not a blank answer");
  check(/room/.test(err.message), "…that says why", err.message);
}
{
  const C = load(async () => ({ ...reply(200), body: { getReader: () => ({ read: async () => { throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" }); } }) } }));
  const err = await C.nemotron.thinkHarder({ question: "q", title: "T", url: "u", chunks: CHUNKS }, NEBIUS).catch((e) => e);
  eq(err.code, "timeout", "a stream that times out → timeout");
}
{
  const C = load(async () => reply(200));
  const err = await C.nemotron.thinkHarder({ question: "q", title: "T", url: "u", chunks: CHUNKS }, {}).catch((e) => e);
  eq(err.code, "no-key", "think harder with no Nebius key → no-key");
}

// ---------------------------------------------------------------- the key check

console.log("\nChecking the key lists the models");
{
  let sent;
  const C = load(async (url, init) => {
    sent = { url, method: init.method ?? "GET", auth: init.headers.Authorization };
    return reply(200, { data: [{ id: "nvidia/Nemotron-3_5-Lightning" }, { id: "nvidia/nemotron-3-super-120b-a12b" }, { id: "meta/llama" }] });
  });
  const out = await C.nemotron.status(NEBIUS);
  eq([sent.url, sent.method, sent.auth], ["https://api.tokenfactory.us-central1.nebius.com/v1/models", "GET", "Bearer nebius-test-key"], "asks Token Factory for its model list");
  eq(out.tools, { Lightning: true, Super: true, Ultra: false }, "shows which of the three are listed");
  check(/Ultra/.test(out.detail), "…and names the missing one", out.detail);
}
{
  const C = load(async () => reply(401, "no"));
  eq((await C.nemotron.status(NEBIUS)).code, "bad-key", "a refused key → bad-key");
}

console.log(`\n${failures ? `${failures} FAILED` : "All passed"} — ${checks} checks, no network, no key, nothing spent.`);
process.exit(failures ? 1 : 0);
