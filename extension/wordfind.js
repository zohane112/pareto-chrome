// Word finder: finds the typed text word for word on the page, like normal Ctrl+F.
// It ignores capitals, finds matches that cross links and bold text, and looks through all
// visible text. It never reads form fields, typing areas, hidden text, or the search box.
// Runs on the user's computer only; nothing is sent anywhere.

(() => {
  const CtrlF = (globalThis.CtrlF ??= {});

  const MAX = 500;
  const SKIP = "input, textarea, select, option, script, style, noscript, template, svg, math, #ctrlf-by-meaning, [contenteditable]:not([contenteditable=false])";
  const INLINE = /^(inline|inline-block|inline-flex|contents|ruby)/;

  // The visible text of the page as one string per run of inline text, with where each
  // character came from. Built once per box and reused.
  function indexPage(root = document.body) {
    const runs = [];
    let run = null;
    let lastBlock = null;
    const blockOf = new Map();
    const block = (el) => {
      if (!blockOf.has(el)) {
        const inline = el.parentElement && INLINE.test(getComputedStyle(el).display);
        blockOf.set(el, inline ? block(el.parentElement) : el);
      }
      return blockOf.get(el);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        if (node.matches(SKIP) || node.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (!node.checkVisibility({ visibilityProperty: true })) {
          return getComputedStyle(node).display === "contents" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const b = block(node.parentElement);
      if (!run || b !== lastBlock) {
        run = { text: "", at: [] };
        runs.push(run);
        lastBlock = b;
      }
      const data = node.data;
      for (let i = 0; i < data.length; i++) {
        const ch = /\s/.test(data[i]) ? " " : data[i];
        if (ch === " " && (run.text.endsWith(" ") || !run.text)) continue; // collapse spaces
        const low = ch.toLowerCase();
        run.text += low.length === 1 ? low : ch;
        run.at.push([node, i]);
      }
    }
    return runs;
  }

  // Returns { ranges, total }: up to 500 Ranges in page order, and how many there were.
  function findWords(query, index) {
    const want = query.replace(/\s+/g, " ").trim().toLowerCase();
    const ranges = [];
    let total = 0;
    if (want.length < 2) return { ranges, total };
    for (const run of index) {
      for (let from = run.text.indexOf(want); from >= 0; from = run.text.indexOf(want, from + want.length)) {
        total++;
        if (ranges.length >= MAX) continue;
        const [startNode, startOffset] = run.at[from];
        const [endNode, endOffset] = run.at[from + want.length - 1];
        const range = new Range();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset + 1);
        ranges.push(range);
      }
    }
    return { ranges, total };
  }

  CtrlF.indexPage = indexPage;
  CtrlF.findWords = findWords;
})();
