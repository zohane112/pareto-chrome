// Scorer: asks Jev which chunk answers a question, and how sure it is that the chunks
// answer it at all. It runs only in the background service worker, the one place that
// holds the Jev key, and is handed the key rather than reading it.
// The HTTP part (timeout, retries, which status means which code) is in net.js, shared
// with the hosted AI provider in ai.js.
// It knows nothing about pages or the search box, so a form filler or browser agent can
// reuse it. The way of asking was chosen in the prototype ticket: TypeSafe's line-search
// pattern, with each chunk's section path in its line.

(() => {
  const CtrlF = (globalThis.CtrlF ??= {});

  const API = "https://api.typesafe.ai/v1/systemone";
  const MODEL = "jev-latest";
  const TOP = 5;
  const MAX_OPTIONS = 255;         // Jev's limit on options in one Choice
  const MAX_STATE_CHARS = 120000;  // keeps state plus the longest question under Jev's 32k-token limit (about 4.2 characters a token)
  const MAX_WINDOWS = 8;           // a page that needs more calls than this is too big to search
  const TIMEOUT_MS = 15000;        // per request

  // `code` says what went wrong, so the search box can explain it in plain English.
  // no-key | bad-key | no-funds | busy | too-big | timeout | offline | jev-error
  class ScoreError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.name = "ScoreError";
      this.code = code;
      Object.assign(this, extra);
    }
  }

  function line(chunk) {
    return chunk.path?.length ? `${chunk.id}| [${chunk.path.join(" > ")}] ${chunk.text}` : `${chunk.id}| ${chunk.text}`;
  }

  function fits(lines) {
    return lines.length <= MAX_OPTIONS && lines.reduce((n, l) => n + l.text.length + 1, 0) <= MAX_STATE_CHARS;
  }

  // The fewest equal windows of consecutive lines that each fit in one call.
  function windowsFor(lines) {
    const chars = lines.reduce((n, l) => n + l.text.length + 1, 0);
    for (let n = Math.max(1, Math.ceil(lines.length / MAX_OPTIONS), Math.ceil(chars / MAX_STATE_CHARS)); ; n++) {
      if (n > MAX_WINDOWS) {
        throw new ScoreError("too-big", `The page needs more than ${MAX_WINDOWS} calls to Jev.`, { max: MAX_WINDOWS });
      }
      const size = Math.ceil(lines.length / n);
      const windows = [];
      for (let i = 0; i < lines.length; i += size) windows.push(lines.slice(i, i + size));
      if (windows.every(fits)) return windows;
    }
  }

  function request(question, lines) {
    return {
      state: lines.map((l) => l.text).join("\n"),
      model: MODEL,
      questions: {
        where: {
          type: "choice",
          instructions: `Which line of the document contains the answer to: "${question}"?`,
          criteria: Object.fromEntries(lines.map((l) => [l.id, null])),
        },
        exists: {
          type: "noul",
          instructions: `Does any line of the document address or answer: "${question}"?`,
          criteria: {
            true: "At least one line of the document states or directly implies the answer",
            false: "No line of the document addresses this",
          },
        },
      },
    };
  }

  // One call to Jev. The timeout, the retries with backoff, and which HTTP status means
  // which code all live in net.js, so the hosted AI provider fails the same way Jev does.
  function post(key, body) {
    return CtrlF.postJson(API, {
      headers: { Authorization: `Bearer ${key}` },
      body,
      timeoutMs: TIMEOUT_MS,
      service: "Jev",
      fallback: "jev-error",
      fail: (code, message, extra) => new ScoreError(code, message, extra),
    });
  }

  // chunks: [{ id, text, path }]. Returns the top 5 chunks plus how sure Jev is that the
  // chunks answer the question at all (`exists`, 0 to 1), and the Jev time in ms.
  // A page too big for one call is split into windows asked at the same time. Each chunk's
  // score is then its window's `exists` times its Choice probability, and the page's
  // `exists` is the highest window's. With one window the order is the same as the plain
  // Choice probabilities.
  async function score(chunks, question, { key }) {
    if (!key) throw new ScoreError("no-key", "No Jev key is saved.");
    if (!chunks.length) return { exists: 0, top: [], ms: 0, tokens: 0, calls: 0, model: null };
    const lines = chunks.map((c) => ({ id: c.id, text: line(c) }));
    const windows = windowsFor(lines);

    const start = performance.now();
    const replies = await Promise.all(windows.map((w) => post(key, request(question, w))));
    const ms = Math.round(performance.now() - start);

    let exists = 0;
    let tokens = 0;
    const ranked = [];
    replies.forEach((reply, i) => {
      const windowExists = reply.answers.exists.noul;
      const probabilities = reply.answers.where.probabilities;
      exists = Math.max(exists, windowExists);
      tokens += reply.usage?.input_tokens ?? 0;
      for (const l of windows[i]) ranked.push({ id: l.id, score: windowExists * (probabilities[l.id] ?? 0) });
    });
    ranked.sort((a, b) => b.score - a.score);

    return { exists, top: ranked.slice(0, TOP), ms, tokens, calls: windows.length, model: replies[0].model };
  }

  // Which sentence of one matched chunk answers the question: a second, small call made
  // after the paragraph is already highlighted. `sentences` is the chunk split into
  // sentences, and `path` its section headings. One sentence needs no call.
  async function pickSentence(sentences, question, { key, path = [] }) {
    if (!key) throw new ScoreError("no-key", "No Jev key is saved.");
    if (sentences.length <= 1) return { index: 0, confidence: 1, ms: 0, tokens: 0 };
    const ids = sentences.slice(0, MAX_OPTIONS).map((_, i) => `s${i + 1}`);
    const heading = path.length ? `[${path.join(" > ")}]\n` : "";
    const start = performance.now();
    const reply = await post(key, {
      state: heading + ids.map((id, i) => `${id}| ${sentences[i]}`).join("\n"),
      model: MODEL,
      questions: {
        which: {
          type: "choice",
          instructions: `Which sentence contains the answer to: "${question}"?`,
          criteria: Object.fromEntries(ids.map((id) => [id, null])),
        },
      },
    });
    const { choice, probabilities = {} } = reply.answers.which;
    const index = Math.max(0, ids.indexOf(choice));
    return { index, confidence: probabilities[ids[index]] ?? 0, ms: Math.round(performance.now() - start), tokens: reply.usage?.input_tokens ?? 0 };
  }

  CtrlF.ScoreError = ScoreError;
  CtrlF.score = score;
  CtrlF.pickSentence = pickSentence;
  CtrlF.chunkLine = line;
})();
