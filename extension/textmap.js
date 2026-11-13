// Text map: finds where a piece of chunk text (like one sentence) sits on the page, as a
// DOM Range that can be highlighted. Chunk text has footnote markers like [12] removed and
// spaces collapsed, so this matches on letters and digits only, skipping marker elements.
// It knows nothing about Jev or the search box, so other tools can reuse it.

(() => {
  const CtrlF = (globalThis.CtrlF ??= {});

  const WORDY = /[\p{L}\p{N}]/u;
  const MARKER_TEXT = /^\s*\[[^\]]{0,40}\]\s*$/; // [12], [a], [citation needed], [note 3]

  // Footnote markers: Wikipedia's sup.reference, the standard noteref role, and
  // superscript links to somewhere on the same page.
  function isMarker(el) {
    if (el.matches("[role=doc-noteref], sup.reference")) return true;
    if (el.localName !== "sup") return false;
    return MARKER_TEXT.test(el.textContent) || !!el.querySelector('a[href^="#"]');
  }

  // Letters and digits in reading order, lower-cased, with where each one came from.
  function indexOf(els) {
    let flat = "";
    const at = []; // [node, offset] per character of `flat`
    for (const el of els) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.nodeType === Node.ELEMENT_NODE
            ? (isMarker(node) || /^(script|style|noscript|template)$/.test(node.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
            : NodeFilter.FILTER_ACCEPT,
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const data = node.data;
        for (let i = 0; i < data.length; i++) {
          const ch = data[i];
          if (!WORDY.test(ch)) continue;
          const low = ch.toLowerCase();
          flat += low.length === 1 ? low : ch;
          at.push([node, i]);
        }
      }
    }
    return { flat, at };
  }

  function squeeze(text) {
    let out = "";
    for (const ch of text) {
      if (ch.length !== 1 || !WORDY.test(ch)) continue;
      const low = ch.toLowerCase();
      out += low.length === 1 ? low : ch;
    }
    return out;
  }

  // Returns a Range over `text` inside `els`, or null when it can't be found.
  // The range runs from the first letter to the end of the last word, including
  // closing punctuation like a full stop or quote mark.
  function rangeFor(els, text) {
    const want = squeeze(text);
    if (!want) return null;
    const { flat, at } = indexOf(els);
    let start = flat.indexOf(want);
    let end = start + want.length;
    if (start < 0) {
      // Close enough: the first and last 24 letters, in order.
      const head = want.slice(0, 24);
      const tail = want.slice(-24);
      start = flat.indexOf(head);
      const tailAt = start < 0 ? -1 : flat.indexOf(tail, start);
      if (start < 0 || tailAt < 0) return null;
      end = tailAt + tail.length;
    }
    const [startNode, startOffset] = at[start];
    let [endNode, endOffset] = at[end - 1];
    endOffset += 1;
    const rest = endNode.data.slice(endOffset).match(/^[^\s\p{L}\p{N}]*/u)[0];
    endOffset += rest.length;
    const range = new Range();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  CtrlF.isMarker = isMarker;
  CtrlF.rangeFor = rangeFor;
})();
