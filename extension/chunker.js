// Chunker: turns the page reader's blocks into the chunks a search scores.
// Each chunk has a short id, its text, its section heading path, and a link back
// to its element so the page can scroll to it and highlight it.
// It knows nothing about Jev, so a form filler or browser agent can reuse it.

(() => {
  const CtrlF = (globalThis.CtrlF ??= {});

  const TINY = 8;          // list items and table rows shorter than this many words get merged
  const MERGE_UP_TO = 40;  // stop adding to a merged chunk once it reaches this many words
  const SPLIT_OVER = 400;  // blocks longer than this many words get split at sentence ends
  const SPLIT_INTO = 250;  // about how many words each split piece gets
  const LOOSE_MIN = 3;     // loose text (in a div, not a paragraph) shorter than this is page furniture like "[edit]"
  const LOOSE_LINKS = 0.5; // loose text that's at least this much link text is navigation, like "Jump to content"

  function words(text) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  function groupOf(block) {
    if (block.kind === "list-item") return block.el.parentElement;
    if (block.kind === "table-row") return block.el.closest("table");
    return null;
  }

  // Headings aren't chunks. They become the section path on every chunk under them.
  // A page with a single h1 is using it as the page title, so it's left out of paths.
  function withPaths(blocks) {
    const titleOnly = blocks.filter((b) => b.kind === "heading" && b.level === 1).length === 1;
    const open = []; // [{ level, text }]
    const out = [];
    for (const b of blocks) {
      if (b.kind === "heading") {
        while (open.length && open.at(-1).level >= b.level) open.pop();
        if (!(titleOnly && b.level === 1)) open.push({ level: b.level, text: b.text });
        continue;
      }
      if (b.loose && (words(b.text) < LOOSE_MIN || b.linkShare >= LOOSE_LINKS)) continue;
      out.push({ ...b, path: open.map((h) => h.text), words: words(b.text) });
    }
    return out;
  }

  // Runs of short list items or table rows from the same list or table become one chunk.
  function mergeTiny(items) {
    const out = [];
    let run = null;
    const flush = () => {
      if (!run) return;
      out.push(run.els.length === 1 ? run.first : {
        ...run.first,
        text: run.texts.join("; "),
        words: run.words,
        els: run.els,
      });
      run = null;
    };
    for (const item of items) {
      const group = groupOf(item);
      const tiny = group && item.words < TINY;
      const fits = run && run.group === group && run.pathKey === item.path.join("\u0000") && run.words < MERGE_UP_TO;
      if (!tiny) { flush(); out.push(item); continue; }
      if (!fits) {
        flush();
        run = { first: item, group, pathKey: item.path.join("\u0000"), texts: [], els: [], words: 0 };
      }
      run.texts.push(item.text);
      run.els.push(item.el);
      run.words += item.words;
    }
    flush();
    return out;
  }

  // Very long blocks (a whole policy dumped in one element) are split at sentence ends,
  // so a match lands near the answer. Normal long paragraphs stay whole.
  function splitHuge(items) {
    const out = [];
    for (const item of items) {
      if (item.words <= SPLIT_OVER) { out.push(item); continue; }
      const sentences = item.text.split(/(?<=[.!?]["”’')\]]?)\s+/);
      const pieces = [];
      let current = [];
      let count = 0;
      for (const s of sentences) {
        const n = words(s);
        if (count && count + n > SPLIT_INTO) { pieces.push(current.join(" ")); current = []; count = 0; }
        current.push(s);
        count += n;
      }
      if (current.length) pieces.push(current.join(" "));
      pieces.forEach((text, i) => out.push({ ...item, text, words: words(text), part: i + 1, parts: pieces.length }));
    }
    return out;
  }

  // Returns [{ id, text, path, kind, el, els, part?, parts? }] in reading order.
  // `el` is the element to scroll to; `els` lists every element a merged chunk covers.
  function chunk(blocks) {
    const items = splitHuge(mergeTiny(withPaths(blocks)));
    return items.map((item, i) => ({
      id: `c${i + 1}`,
      text: item.text,
      path: item.path,
      kind: item.kind,
      el: item.el,
      els: item.els ?? [item.el],
      ...(item.parts && { part: item.part, parts: item.parts }),
    }));
  }

  // Reads the current page and chunks it, timing both.
  function chunkPage(root = document.body) {
    const start = performance.now();
    const blocks = CtrlF.readPage(root);
    const chunks = chunk(blocks);
    const ms = Math.round(performance.now() - start);
    const totalWords = chunks.reduce((sum, c) => sum + words(c.text), 0);
    return { chunks, stats: { ms, blocks: blocks.length, chunks: chunks.length, words: totalWords } };
  }

  // Splits a chunk's text into sentences, for pointing at the exact one that answers.
  // Uses the browser's own sentence rules, after putting back the space a removed footnote
  // marker leaves out ("techniques.[146]Deep" reads "techniques.Deep"). Then it glues back
  // pieces that start in lower case ("Jeopardy! quiz show") or are under 3 words (a split
  // after an abbreviation like "Dr."). Spacing doesn't matter for finding the sentence on the page.
  const segmenter = globalThis.Intl?.Segmenter ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
  function sentences(text) {
    // Only after a word or a number, so initials like "U.S.Army" stay whole.
    const spaced = text.replace(/(?<=[a-z]{2}|[0-9%)])([.!?]["”’')\]]?)(?=[A-Z“"‘])/g, "$1 ");
    const raw = segmenter
      ? [...segmenter.segment(spaced)].map((s) => s.segment.trim())
      : spaced.split(/(?<=[.!?]["”’')\]]?)\s+(?=[A-Z0-9“"‘(\[])/);
    const out = [];
    for (const s of raw.filter(Boolean)) {
      const glue = out.length && (/^[a-z]/.test(s) || words(s) < 3 || words(out.at(-1)) < 3);
      if (glue) out[out.length - 1] += ` ${s}`;
      else out.push(s);
    }
    return out;
  }

  CtrlF.chunk = chunk;
  CtrlF.chunkPage = chunkPage;
  CtrlF.sentences = sentences;
})();
