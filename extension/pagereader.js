// Page reader: walks the rendered page and collects its text as blocks
// (paragraphs, list items, table rows, headings) in reading order.
// It never reads form fields, and it skips menus, page headers and footers, ads,
// reference lists, and anything hidden.
// It knows nothing about chunks or Jev, so a form filler or browser agent can reuse it.

(() => {
  const CtrlF = (globalThis.CtrlF ??= {});

  // Never read what's typed or chosen in these. Their whole insides are skipped.
  const FORM_FIELDS = new Set(["input", "textarea", "select", "option", "optgroup", "datalist"]);

  // Not text a reader sees.
  const NOT_TEXT = new Set([
    "script", "style", "noscript", "template", "svg", "math", "canvas",
    "iframe", "object", "embed", "video", "audio",
  ]);

  const SKIP = [
    "#ctrlf-by-meaning", // our own search box
    // Menus
    "nav", "[role=navigation]", "[role=menu]", "[role=menubar]", "[role=search]",
    "[role=banner]", "[role=contentinfo]", "[role=complementary]",
    ".navigation-not-searchable", // Wikipedia's own mark for "Main article: …" pointers
    // Hidden from everyone
    "[hidden]", "[aria-hidden=true]",
    // Ads
    "ins.adsbygoogle", "[id^=google_ads]", "[id^=div-gpt-ad]", "[data-ad-slot]",
    "[data-ad-unit]", "[aria-label=Advertisement]", ".advertisement",
    // Reference and footnote lists: citations, not answers
    "[role=doc-endnotes]", "[role=doc-bibliography]",
    ".references", ".reflist", ".refbegin", ".mw-references-wrap",
  ].join(",");

  // Elements that hold their own text. Text belongs to the nearest one above it.
  const BLOCKS = new Set([
    "p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
    "dt", "dd", "blockquote", "pre", "figcaption", "caption", "summary",
  ]);

  // Wrappers. A wrapper with no blocks inside it is just part of the block around it.
  // A wrapper that holds blocks is a container, and loose text in it is a block of its own.
  const WRAPPERS = new Set([
    "div", "section", "article", "main", "aside", "header", "footer",
    "td", "th", "form", "fieldset", "details", "address", "center", "body",
  ]);

  const BLOCKS_SELECTOR = [...BLOCKS, "[role=heading]"].join(",");

  function isHeadingRole(el) {
    return el.getAttribute("role") === "heading";
  }

  function isBlock(el) {
    return BLOCKS.has(el.localName) || isHeadingRole(el);
  }

  // Page-wide header, footer, and sidebar. The same tags inside an article or section belong
  // to that article and are kept (this follows how browsers decide their roles).
  function isPageChrome(el) {
    const tag = el.localName;
    const scope = el.parentElement;
    if (tag === "header" || tag === "footer") {
      return !scope?.closest("article, aside, main, nav, section, [role=main], [role=article]");
    }
    if (tag === "aside") return !scope?.closest("article, aside, nav, section, [role=article]");
    return false;
  }

  // Text shrunk to a 1-pixel box for screen readers only, like "(opens a new window)".
  function isVisuallyHidden(el) {
    return el.offsetWidth <= 1 && el.offsetHeight <= 1 && getComputedStyle(el).overflow !== "visible";
  }

  function kindOf(el) {
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag) || isHeadingRole(el)) return "heading";
    if (tag === "li") return "list-item";
    if (tag === "tr") return "table-row";
    return "paragraph";
  }

  function headingLevel(el) {
    const m = /^h([1-6])$/.exec(el.localName);
    if (m) return Number(m[1]);
    return Number(el.getAttribute("aria-level")) || 2;
  }

  function clean(text) {
    return text
      .replace(/\[\s*(?:\d+|[a-z]|citation needed|note \d+|nb \d+)\s*\]/gi, "") // footnote markers like [12]
      .replace(/\s+/g, " ")
      .trim();
  }

  // Returns [{ el, kind, level?, text, loose, linkShare }] in reading order.
  // `loose` means the text sat in a wrapper (like a div) rather than a real paragraph or list item.
  // `linkShare` is how much of the text is link text, from 0 to 1.
  function readPage(root = document.body) {
    const hasBlocksInside = new Map();
    const ownerOf = new Map();
    const visibleText = new Map();

    function isContainer(el) {
      if (!hasBlocksInside.has(el)) hasBlocksInside.set(el, !!el.querySelector(BLOCKS_SELECTOR));
      return hasBlocksInside.get(el);
    }

    // The block a piece of text belongs to, found from the element holding the text.
    function findOwner(start) {
      if (ownerOf.has(start)) return ownerOf.get(start);
      // Climb until a real block (the text is part of it) or a container (the text is loose in it).
      // Loose text takes the outermost plain wrapper below the container, so a card's pieces stay together.
      let owner = null;
      let outerWrapper = null;
      for (let el = start; el && el !== root.parentElement; el = el.parentElement) {
        if (isBlock(el)) { owner = el; break; }
        if (WRAPPERS.has(el.localName)) {
          if (isContainer(el)) { owner = outerWrapper ?? el; break; }
          outerWrapper = el;
        }
      }
      owner ??= outerWrapper ?? root;
      ownerOf.set(start, owner);
      return owner;
    }

    // The table cell or wrapper a piece of text sits in, so cells and wrappers get a gap between them.
    function segmentOf(start, owner) {
      for (let el = start; el && el !== owner; el = el.parentElement) {
        if (WRAPPERS.has(el.localName)) return el;
      }
      return owner;
    }

    function isVisibleText(parent) {
      if (!visibleText.has(parent)) visibleText.set(parent, getComputedStyle(parent).visibility === "visible");
      return visibleText.get(parent);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!node.data.trim()) return NodeFilter.FILTER_REJECT;
          return isVisibleText(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
        const el = node;
        const tag = el.localName;
        if (NOT_TEXT.has(tag) || FORM_FIELDS.has(tag)) return NodeFilter.FILTER_REJECT;
        if (el.isContentEditable) return NodeFilter.FILTER_REJECT; // someone's typing area
        if (el.matches(SKIP) || isPageChrome(el)) return NodeFilter.FILTER_REJECT;
        if (!el.checkVisibility()) {
          // display: contents has no box of its own, but its children still show.
          return getComputedStyle(el).display === "contents" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
        }
        if (isVisuallyHidden(el)) return NodeFilter.FILTER_REJECT;
        return tag === "br" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });

    const found = new Map(); // owner element -> block being built
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const owner = findOwner(node.nodeType === Node.TEXT_NODE ? parent : parent.parentElement);
      let block = found.get(owner);
      if (!block) {
        block = { el: owner, parts: [], segment: null, links: 0, chars: 0 };
        found.set(owner, block);
      }
      if (node.nodeType !== Node.TEXT_NODE) {
        block.parts.push(" "); // <br>
        continue;
      }
      const segment = segmentOf(parent, owner);
      if (block.segment && segment !== block.segment) {
        const inCells = /^t[dh]$/.test(segment.localName) || /^t[dh]$/.test(block.segment.localName);
        block.parts.push(inCells ? " | " : " ");
      }
      block.segment = segment;
      block.parts.push(node.data);
      const size = node.data.trim().length;
      block.chars += size;
      if (parent.closest("a")) block.links += size;
    }

    const blocks = [];
    for (const b of found.values()) {
      const text = clean(b.parts.join(""));
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const kind = kindOf(b.el);
      blocks.push({
        el: b.el,
        kind,
        ...(kind === "heading" && { level: headingLevel(b.el) }),
        text,
        loose: !isBlock(b.el),
        linkShare: b.chars ? b.links / b.chars : 0,
      });
    }
    return dropLinkLists(blocks);
  }

  // A list where every item is just a link, or every item cites a source, is a menu
  // or a bibliography, not content.
  function dropLinkLists(blocks) {
    const byList = new Map();
    for (const b of blocks) {
      if (b.kind !== "list-item") continue;
      const list = b.el.parentElement;
      if (!byList.has(list)) byList.set(list, []);
      byList.get(list).push(b);
    }
    const drop = new Set();
    for (const items of byList.values()) {
      if (items.every((b) => b.linkShare >= 0.9) || items.every((b) => b.el.querySelector("cite"))) {
        for (const b of items) drop.add(b);
      }
    }
    return blocks.filter((b) => !drop.has(b));
  }

  CtrlF.readPage = readPage;
})();
