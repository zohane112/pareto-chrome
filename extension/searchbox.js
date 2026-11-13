// The search box. It's loaded into every page ahead of time, so the shortcut opens it without
// waiting for anything, and it reads the page only once the box is on screen. It never
// touches the keys: every Jev, Nemotron or AI call goes through the background worker.
// The look, one of two picked in settings: "digital" (a light panel with black type, the answer
// inverted to black, seven-segment numbers like a clock) or "terminal" (plain black and grey
// monospace).

(() => {
  // Loaded twice (declared in the manifest, then injected again into a tab that was open
  // before an install or reload)? Keep the live copy. A copy left over from before a reload
  // has lost its connection to the extension, so the new one takes over.
  if (window.__ctrlfByMeaning?.alive()) return;
  const alive = () => !!globalThis.chrome?.runtime?.id;

  const NOT_FOUND_BELOW = 0.5; // Jev's "the page answers this" probability, from the prototype ticket
  const MIN_SCORE = 0.02;      // the arrows skip weaker guesses than this (the best match always shows)

  let box = null; // { focus, setLook, progress } while the box is open

  // The look ("digital" or "terminal"), read ahead of time so the box opens in it straight
  // away. Only this one setting is read here; the keys stay with the background worker.
  let look = "digital";
  chrome.storage.local.get("look").then((saved) => { if (saved.look === "terminal") look = "terminal"; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.look) return;
    look = changes.look.newValue === "terminal" ? "terminal" : "digital";
    box?.setLook(look);
  });

  // The typefaces bundled with the extension (fonts/, SIL Open Font License). They're added to
  // the page's font list from the files' bytes the first time the box opens, so a page's own
  // rules can't block them. Until they load, and if they can't, system fonts stand in.
  let fontsLoading = null;
  function loadFonts() {
    fontsLoading ??= Promise.all([
      ["CtrlF Geist Mono", "GeistMono-Regular.ttf", "400"], ["CtrlF Geist Mono", "GeistMono-Medium.ttf", "500"],
      ["CtrlF Geist", "Geist-Regular.ttf", "400"], ["CtrlF Geist", "Geist-Medium.ttf", "500"],
      ["CtrlF DSEG7", "DSEG7Classic-Bold.ttf", "700"],
    ].map(async ([family, file, weight]) => {
      const res = await fetch(chrome.runtime.getURL(`fonts/${file}`));
      const face = new FontFace(family, await res.arrayBuffer(), { weight });
      await face.load();
      document.fonts.add(face);
    })).catch(() => {});
    return fontsLoading;
  }
  function open() {
    if (!alive()) return false;
    if (box) box.focus();
    else box = createBox();
    return true;
  }
  window.__ctrlfByMeaning = { open, alive };

  // The shortcut and the toolbar button: Chrome tells the background worker, which tells us.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "open") sendResponse({ opened: open() });
    // How far Nemotron 3 Ultra has got with a think-harder answer, as it streams in.
    if (message?.type === "deepProgress") box?.progress(message);
  });

  // Control+Shift+F pressed in the page. Chrome normally catches its own shortcut first and
  // tells the worker; this is for when it doesn't, like when another extension has the keys.
  addEventListener("keydown", (event) => {
    // Only a real key press: a page's scripts can't open the box by faking one.
    if (!event.isTrusted || event.code !== "KeyF" || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || !alive()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open();
  }, true);

  const ICONS = {
    up: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8L6 4L10 8"/></svg>',
    down: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4L6 8L10 4"/></svg>',
    left: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 1.5L3 5L6.5 8.5"/></svg>',
    right: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 1.5L7 5L3.5 8.5"/></svg>',
  };

  function createBox() {
    // A box left behind by a copy from before a reload can't search any more: replace it.
    document.getElementById("ctrlf-by-meaning")?.remove();

    const host = document.createElement("div");
    host.id = "ctrlf-by-meaning";
    // A closed shadow root keeps the page's styles and scripts out of the box.
    const root = host.attachShadow({ mode: "closed" });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        /* Two looks, chosen in settings. digital: a light panel with black type, like an
           inverted terminal; the answer turns black; seven-segment numbers; one amber light,
           never used for text. terminal: plain black and grey monospace. The fonts are bundled
           (fonts/, SIL Open Font License). */
        .stage {
          --bg: #f6f6f3; --fg: #0c0c0c; --soft: #3a3a36; --dim: #62625d; --line: #cfcfc9; --rule: #e1e1dc;
          --inv: #0c0c0c; --on-inv: #f6f6f3; --signal: #f5a000; --hover: #8a5a00; --well: #e6e6e1;
          --mono: "CtrlF Geist Mono", "Geist Mono", ui-monospace, Menlo, Consolas, monospace;
          --read: "CtrlF Geist", "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          --display: "CtrlF DSEG7", var(--mono);
          --radius: 16px; --shadow: 0 18px 44px rgba(12, 12, 12, 0.16), 0 2px 6px rgba(12, 12, 12, 0.06);
          position: fixed; top: 14px; right: 14px; z-index: 2147483647; width: min(420px, calc(100vw - 28px));
          font: 400 12px/1.5 var(--mono); color: var(--fg); -webkit-font-smoothing: antialiased; text-align: left;
        }
        .stage[data-look="terminal"] {
          --bg: #0e0e0e; --fg: #e8e8e3; --soft: #bdbdb7; --dim: #8c8c86; --line: #2e2e2b; --rule: #2e2e2b;
          --inv: #e8e8e3; --on-inv: #0e0e0e; --well: #1a1a19; --hover: #f5a000;
          --read: var(--mono); --display: var(--mono);
          --radius: 8px; --shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
        }
        .window {
          position: relative; display: flex; flex-direction: column; max-height: calc(100vh - 28px);
          background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow);
          animation: appear 140ms cubic-bezier(.2, .8, .2, 1);
        }
        @keyframes appear { from { opacity: 0; transform: translateY(-6px) scale(0.99); } }
        button {
          all: unset; box-sizing: border-box; display: inline-grid; place-items: center; cursor: pointer;
          color: var(--fg); font: 400 11px/1 var(--mono);
        }
        button:focus-visible { outline: 1px solid var(--fg); outline-offset: 2px; }
        .icon, .small { width: 24px; height: 24px; border: 1px solid var(--line); border-radius: 999px; color: var(--fg); }
        .small { width: 22px; height: 22px; }
        .stage[data-look="terminal"] .icon, .stage[data-look="terminal"] .small { border-radius: 4px; }
        .icon svg, .small svg { width: 10px; height: 10px; }
        .icon:hover:not(:disabled), .small:hover:not(:disabled) { background: var(--inv); color: var(--on-inv); border-color: var(--inv); }
        .icon:disabled, .small:disabled { color: var(--line); cursor: default; }
        .close { width: 22px; height: 24px; color: var(--dim); font-size: 16px; }
        .close:hover { color: var(--fg); }
        .primary {
          height: 24px; padding: 0 12px; border-radius: 999px; background: var(--inv); color: var(--on-inv);
          transition: transform 80ms ease;
        }
        .stage[data-look="terminal"] .primary { border-radius: 4px; }
        .primary:hover { transform: translateY(-1px); }
        .body { padding: 11px 14px 10px; overflow: auto; min-height: 0; }
        .row { display: flex; align-items: center; gap: 6px; cursor: grab; }
        .row:active { cursor: grabbing; }
        .prompt { font-size: 15px; font-weight: 500; user-select: none; width: 12px; }
        .prompt::before { content: "›"; }
        .stage[data-look="terminal"] .prompt::before { content: "$"; color: var(--dim); }
        input {
          all: unset; flex: 1; min-width: 0; padding: 4px 2px; font: 400 14px/1.3 var(--mono); color: var(--fg);
          caret-color: var(--fg); caret-shape: block; cursor: text;
        }
        input::placeholder { color: var(--dim); }
        .status:empty { display: none; }
        .status { margin: 10px -14px 0; padding: 9px 14px 0; border-top: 1px dashed var(--line); }
        .stage[data-look="terminal"] .status { border-top-style: solid; }
        .line { display: flex; align-items: baseline; gap: 10px; }
        .status-main { flex: 1; min-width: 0; white-space: pre-line; color: var(--soft); }
        .status-main b { font: 700 19px/1 var(--display); color: var(--fg); }
        .status-main b .unit { font: 500 11px/1 var(--mono); margin-left: 1px; }
        .stage[data-look="terminal"] .status-main b { font: 500 12px/1.5 var(--mono); }
        .stage[data-look="terminal"] .status-main b .unit { font: inherit; margin: 0; }
        .status-main.ok::before, .status-main.miss::before, .status-main.err::before {
          content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; background: var(--fg);
        }
        .status-main.miss::before, .status-main.err::before { background: var(--signal); }
        /* Busy: five short segments, one lit at a time, stepping along. */
        .status-main.busy::before {
          content: ""; display: inline-block; width: 53px; height: 4px; margin-right: 8px; vertical-align: 2px;
          background: linear-gradient(var(--fg), var(--fg)) 0 0 / 9px 4px no-repeat,
            repeating-linear-gradient(90deg, var(--line) 0 9px, transparent 9px 11px);
          animation: step 1s steps(5) infinite;
        }
        @keyframes step { to { background-position: 55px 0, 0 0; } }
        .status-meta { font-size: 10.5px; color: var(--dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
        .status > .primary { margin-top: 8px; }
        /* How sure Jev is: a row of segments like a level meter, lit in ink one at a time. */
        .meter { margin-top: 8px; height: 8px; background: repeating-linear-gradient(90deg, var(--line) 0 6px, transparent 6px 9px); }
        .meter i {
          display: block; width: 0; height: 8px; transition: width 600ms steps(24);
          background: repeating-linear-gradient(90deg, var(--fg) 0 6px, transparent 6px 9px);
        }
        .meter.low i { background: repeating-linear-gradient(90deg, var(--dim) 0 6px, transparent 6px 9px); }
        .meter.busy i { width: 18%; transition: none; animation: sweep 900ms steps(14) infinite alternate; }
        @keyframes sweep { from { margin-left: 0; } to { margin-left: 82%; } }
        .panel {
          display: grid; grid-template-columns: 62px minmax(0, 1fr); column-gap: 10px;
          margin: 10px -14px 0; padding: 10px 14px 0; border-top: 1px solid var(--rule);
        }
        .label { font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); padding-top: 2px; }
        .stage[data-look="terminal"] .label { font-size: 10.5px; letter-spacing: 0; text-transform: none; }
        .stage[data-look="terminal"] .label::before { content: "# "; }
        .words { align-items: center; }
        .words .label { padding-top: 0; }
        .words-row { display: flex; align-items: center; gap: 5px; }
        .words-label { flex: 1; color: var(--soft); }
        ol.sources { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
        ol.sources li { display: grid; grid-template-columns: auto 1fr; gap: 6px; font: 400 12px/1.5 var(--read); color: var(--soft); }
        ol.sources .n { font-family: var(--mono); font-size: 10.5px; color: var(--fg); font-variant-numeric: tabular-nums; }
        ol.sources .n::before { content: "["; color: var(--dim); }
        ol.sources .n::after { content: "]"; color: var(--dim); }
        a { color: var(--fg); word-break: break-word; text-underline-offset: 2px; }
        a:hover { color: var(--hover); }
        .answer { margin: 0; font: 400 13.5px/1.55 var(--read); color: var(--fg); white-space: pre-wrap; }
        .answer.muted { color: var(--dim); font: 400 12px/1.55 var(--mono); }
        .quote-text { margin: 0; font: 400 13.5px/1.6 var(--read); color: var(--soft); }
        /* The sentence that answers, inverted like a terminal selection. */
        .quote-text mark {
          background: var(--inv); color: var(--on-inv); padding: 1px 5px; border-radius: 4px;
          -webkit-box-decoration-break: clone; box-decoration-break: clone;
        }
        .stage[data-look="terminal"] .quote-text mark { border-radius: 0; }
        .quote .foot-row { margin-top: 7px; }
        .hints { display: flex; flex-wrap: wrap; gap: 3px 12px; margin: 10px -14px -2px; padding: 8px 14px 0; border-top: 1px solid var(--rule); font-size: 10.5px; color: var(--dim); cursor: grab; user-select: none; }
        .hints b { font-weight: 500; color: var(--fg); }
        .dots::after { content: ""; animation: dots 1.2s steps(4) infinite; }
        @keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
        .foot-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
        .foot { flex: 1; font-size: 10.5px; color: var(--dim); }
        .content > .primary { margin-top: 8px; }
        .vs { display: grid; grid-template-columns: 46px 1fr auto; gap: 4px 8px; align-items: center; font-size: 10.5px; }
        .bar { height: 8px; background: repeating-linear-gradient(90deg, var(--line) 0 6px, transparent 6px 9px); }
        .bar i { display: block; height: 100%; background: repeating-linear-gradient(90deg, var(--fg) 0 6px, transparent 6px 9px); }
        .bar.other i { background: repeating-linear-gradient(90deg, var(--dim) 0 6px, transparent 6px 9px); }
        .pickline { grid-column: 2 / 4; font-size: 10px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: -2px; }
        .verdict { margin-top: 6px; font-size: 10.5px; color: var(--soft); }
        .plan { margin: 10px 0 0; font-size: 11px; color: var(--dim); }
        @media (prefers-reduced-motion: reduce) { .window, .meter.busy i, .dots::after, .status-main.busy::before { animation: none !important; } }
      </style>
      <div class="stage">
        <div class="window" role="dialog" aria-label="Pareto">
          <form class="body" autocomplete="off">
            <div class="row">
              <span class="prompt" aria-hidden="true"></span>
              <input type="text" placeholder="find on this page" aria-label="Find on this page" spellcheck="false">
              <button type="button" class="icon prev" aria-label="Previous match" title="Previous match (↑)" disabled>${ICONS.up}</button>
              <button type="button" class="icon next" aria-label="Next match" title="Next match (↓)" disabled>${ICONS.down}</button>
              <button type="button" class="close" aria-label="Close" title="Close (Esc)">×</button>
            </div>
            <div class="status" role="status"></div>
            <div class="meter" aria-hidden="true" hidden><i></i></div>
            <p class="plan" hidden>Meaning search and AI answers are part of the AI plan. <a href="#" class="upgrade">See the AI plan</a></p>
            <section class="panel ai" hidden>
              <div class="label ai-label">answer</div>
              <div class="content"><p class="answer"></p>
                <div class="foot-row"><span class="foot"></span><button type="button" class="primary ask" title="Ask the AI again">ask again</button></div>
              </div>
            </section>
            <section class="panel quote" hidden>
              <div class="label">on page</div>
              <div class="content"><p class="quote-text"></p>
                <div class="foot-row"><span class="foot quote-foot"></span><button type="button" class="primary jump" title="Scroll back to it">show it</button></div>
              </div>
            </section>
            <section class="panel sources" hidden>
              <div class="label">sources</div>
              <div class="content"><ol class="sources"></ol></div>
            </section>
            <section class="panel words" hidden>
              <div class="label">words</div>
              <div class="words-row"><span class="words-label"></span>
                <button type="button" class="small word-prev" aria-label="Previous word-for-word match" title="Previous (Shift+↑)">${ICONS.left}</button>
                <button type="button" class="small word-next" aria-label="Next word-for-word match" title="Next (Shift+↓)">${ICONS.right}</button>
              </div>
            </section>
            <section class="panel compare" hidden>
              <div class="label">compare</div>
              <div class="content"><div class="vs"></div><div class="verdict"></div></div>
            </section>
            <div class="hints" aria-hidden="true"></div>
          </form>
        </div>
      </div>
    `;

    const $ = (sel) => root.querySelector(sel);
    const stage = $(".stage");
    stage.dataset.look = look;
    loadFonts();
    const form = $("form");
    const input = $("input");
    const prev = $(".prev");
    const next = $(".next");
    const status = $(".status");
    const meter = $(".meter");
    const planNote = $(".plan");
    const wordsPanel = $(".words");
    const sourcesPanel = $(".sources");
    const aiPanel = $(".ai");
    const comparePanel = $(".compare");
    const quotePanel = $(".quote");
    const hints = $(".hints");
    const windowEl = $(".window");

    // Every Jev or AI request goes through the background worker. Each one gets a time limit,
    // and a lost link to the extension (it was reloaded or updated since this page loaded)
    // fails at once, so the box never waits forever.
    const ask = (type, payload = {}, limitMs = 20000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("No answer in time."), { code: "slow" })), limitMs);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      try {
        chrome.runtime.sendMessage({ type, ...payload }).then(settle(resolve), settle(reject));
      } catch (err) {
        settle(reject)(err);
      }
    });
    const LIMITS = { search: 70000, ask: 150000, compare: 90000, deep: 200000 }; // Jev retries when busy; the AI tries 3 tools; Ultra thinks

    // The status line: what happened on the left, counts and time on the right.
    // `kind` picks the symbol in front: ok ✓, miss or err ✗, busy (a spinner).
    function say(text = "", meta = "", strong = "", kind = "") {
      if (!text && !meta) return status.replaceChildren();
      const main = document.createElement("span");
      main.className = `status-main${kind ? ` ${kind}` : ""}`;
      if (strong) {
        // "99% sure": the number in the big seven-segment type, the "%" (which that face
        // doesn't have) in mono beside it, and the rest as normal text.
        const b = document.createElement("b");
        const parts = /^(\d+)%\s*(.*)$/.exec(strong);
        if (parts) {
          const unit = document.createElement("span");
          unit.className = "unit";
          unit.textContent = "%";
          b.append(parts[1], unit);
          main.append(b, parts[2] ? ` ${parts[2]}` : "");
        } else {
          b.textContent = strong;
          main.append(b);
        }
      }
      main.append(text);
      const right = document.createElement("span");
      right.className = "status-meta";
      right.textContent = meta;
      const line = document.createElement("div");
      line.className = "line";
      line.append(main, right);
      status.replaceChildren(line);
    }
    function setMeter(value, busy = false) {
      meter.hidden = false;
      meter.classList.toggle("busy", busy);
      meter.classList.toggle("low", !busy && value < NOT_FOUND_BELOW);
      meter.firstElementChild.style.width = busy ? "" : `${Math.round(value * 100)}%`;
    }

    // The box shows first; the page is read just after it has appeared, so opening never
    // waits on a long page. A search waits for the reading if it isn't done yet.
    let chunks = [];
    let toScore = [];
    let byId = new Map();
    let reading = null;
    let unreadable = false; // the reader failed on this page
    function readPage() {
      reading ??= new Promise((resolve) => {
        let done = false;
        const read = () => {
          if (done) return;
          done = true;
          unreadable = false;
          try {
            const page = CtrlF.chunkPage(document.body ?? document.documentElement);
            chunks = page.chunks;
            console.log(`Pareto read ${page.stats.chunks} chunks (${page.stats.words} words) in ${page.stats.ms} ms.`);
          } catch (err) {
            // A page built in a way the reader doesn't expect: search it as empty, never hang.
            chunks = [];
            unreadable = true;
            console.warn("Pareto couldn't read this page:", err);
          }
          // What the background worker needs to ask Jev. Elements stay here in the page.
          toScore = chunks.map(({ id, text, path }) => ({ id, text, path }));
          byId = new Map(chunks.map((c) => [c.id, c]));
          resolve();
        };
        const soon = () => {
          requestAnimationFrame(() => setTimeout(read, 0));
          setTimeout(read, 60); // background tabs don't get animation frames
        };
        // Opened while the page is still arriving: read it once its text is all there, or
        // after 1.5 seconds with whatever has arrived, for a page that keeps loading.
        if (document.readyState === "loading") {
          addEventListener("DOMContentLoaded", soon, { once: true });
          setTimeout(soon, 1500);
        } else soon();
      });
      return reading;
    }
    // A page that changed since it was read (a web app re-drawing itself) is read again.
    const pageChanged = () => chunks.some((c) => !c.el.isConnected);
    function rereadPage() {
      reading = null;
      wordIndex = null;
      return readPage();
    }

    // Highlights on the page, one per kind, coloured by highlight.css. Chrome older than 105
    // has no CSS.highlights, and there the box still scrolls to the match.
    const canHighlight = !!(globalThis.Highlight && CSS.highlights);
    const layers = {};
    ["ctrlf-match", "ctrlf-sentence", "ctrlf-word", "ctrlf-word-now"].forEach((name, priority) => {
      if (!canHighlight) return;
      layers[name] = new Highlight();
      layers[name].priority = priority;
      CSS.highlights.set(name, layers[name]);
    });
    const paint = (name, ranges) => {
      const layer = layers[name];
      if (!layer) return;
      layer.clear();
      for (const r of ranges) layer.add(r);
    };

    // Free: word-for-word find only, on this computer. AI plan: meaning search with Jev, and
    // AI answers. Until the worker answers, assume the AI plan so Enter isn't lost.
    let settings = { plan: "ai", aiProvider: "nemotron", aiAuto: true, hasJevKey: true, hasNebiusKey: false, hasHostedKey: true };
    const aiPlan = () => settings.plan === "ai";
    const hasFinder = () => settings.hasJevKey || settings.hasNebiusKey;
    // ⌘ Enter on a Mac, Ctrl+Enter elsewhere: think harder with Nemotron 3 Ultra.
    const onMac = /Mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
    const DEEP_KEY = onMac ? "⌘↵" : "ctrl↵";
    function showHints() {
      const keys = aiPlan()
        ? [["↵", "ask"], [DEEP_KEY, "think harder"], ["↑↓", "answers"], ["⇧↑↓", "words"], ["esc", "close"]]
        : [["↵", "next match"], ["⇧↵", "previous"], ["esc", "close"]];
      hints.replaceChildren(...keys.map(([k, what]) => {
        const span = document.createElement("span");
        const b = document.createElement("b");
        b.textContent = k;
        span.append(b, ` ${what}`);
        return span;
      }));
    }
    showHints();
    ask("settings").then((reply) => {
      if (reply?.result) settings = reply.result;
      input.placeholder = aiPlan() ? "ask a question, or type words to find" : "find on this page";
      input.setAttribute("aria-label", input.placeholder);
      showHints();
      if (aiPlan() && !hasFinder() && !input.value) noKeyYet();
    }).catch(() => {});

    // Plain-English messages for each way a search can fail. `e.service` says who failed:
    // Jev, or Nemotron when it was doing the finding.
    const who = (e) => e?.service ?? "Jev";
    const PROBLEMS = {
      "no-key": () => "No key saved yet. Add a Jev key or a Nebius key (for Nemotron) in settings.",
      "bad-key": (e) => `${who(e)} didn't accept your key. Check it in settings.`,
      "no-funds": (e) => (who(e) === "Jev"
        ? "Your Jev account is out of funds. Add funds at console.typesafe.ai, under Billing."
        : "Your Nebius account is out of credit. Add credit at tokenfactory.nebius.com."),
      busy: (e) => `${who(e)} is busy right now. Wait a few seconds and try again.`,
      "too-big": (e) => (who(e) === "Jev"
        ? `This page is too long to search. It would take more than ${e.max} calls to Jev. Add a Nebius key and Nemotron can read it in one go.`
        : "This page is too long to search, even for Nemotron."),
      timeout: (e) => `${who(e)} took too long to answer. Try again.`,
      offline: (e) => `Couldn't reach ${who(e)}. Check your internet connection and try again.`,
      "free-plan": () => "Meaning search is part of the AI plan.",
      "jev-error": (e) => `${who(e)} returned an error${e.status ? ` (${e.status})` : ""}. Try again.`,
      slow: () => "No answer in time. Try again in a moment.",
      reload: () => "The extension was updated since this page opened. Reload the page, then try again.",
    };
    // Why Nemotron did the finding instead of Jev, in a few words for the status line.
    const BECAUSE = {
      "no-funds": "Jev out of funds", "bad-key": "Jev key refused", busy: "Jev busy",
      timeout: "Jev too slow", "jev-error": "Jev error", "too-big": "too long for Jev",
    };
    // A failed request, as one of the codes above.
    const problemOf = (err) => (!alive() ? { code: "reload" } : err?.code === "slow" ? { code: "slow" } : { code: "jev-error", message: err?.message });

    // The same, for the AI that writes the answer. Its codes come from ai.js, and the ones
    // it shares with the scorer (bad-key, no-funds, busy, timeout, offline) mean the same
    // thing here. The answer on the page doesn't depend on any of this, so every message
    // says the search itself still worked.
    const AI_PROBLEMS = {
      "no-bridge": () => "Written answers need the AI helper for this Mac, which isn't installed. The answer on the page works without it. Switch to the hosted AI in settings, or turn AI answers off.",
      "no-key": () => "Written answers need an AI key. Add one in settings, or turn AI answers off. The answer on the page works without it.",
      "bad-key": () => "The AI didn't accept your key. Check it in settings.",
      "no-funds": () => "Your AI account is out of funds. Add funds with your AI provider, or switch provider in settings.",
      busy: () => "The AI is busy right now. Wait a few seconds and ask again.",
      timeout: () => "The AI took too long to answer. Ask again.",
      offline: () => "Couldn't reach the AI. Check your internet connection and ask again.",
      "all-failed": (e) => ((e.tried ?? []).length
        ? "None of the AI tools answered.\n" + e.tried.map((t) => `${t.tool}: ${t.error}`).join("\n")
        : "The AI didn't answer."),
      "api-error": (e) => `${e.service ?? "The AI"} returned an error${e.status ? ` (${e.status})` : ""}${e.message && !e.status ? `: ${e.message}` : ""}. Ask again.`,
      "too-big": () => "This page is too long for Nemotron 3 Ultra to read in one go. Press Enter for a normal search instead.",
      off: () => "AI answers are turned off in settings.",
      default: (e) => `The AI couldn't answer: ${e.message ?? "unknown error"}`,
    };
    const AI_NEEDS_SETTINGS = new Set(["no-bridge", "no-key", "bad-key", "no-funds"]);

    function settingsButton(label = "Open settings") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "primary extra";
      b.textContent = label;
      b.addEventListener("click", () => ask("openSettings"));
      return b;
    }

    function noKeyYet() {
      say("No key saved yet. Add a Jev key or a Nebius key (for Nemotron) in settings to search by meaning.", "", "", "err");
      status.append(settingsButton());
    }

    // Only the newest search gets to show its answer.
    let latest = 0;
    let question = "";
    // The current meaning results: the chunks the arrows step through, and which one is showing.
    let matches = [];
    let current = 0;
    let sure = "";   // "99% sure"
    let timing = ""; // "Jev · 325 ms"
    let verdict = " this page answers it"; // after `sure` on the status line
    let found = null; // the latest search result: Jev's, Lightning's, or Ultra's lines
    const sentenceOf = new Map(); // chunk id -> Promise<{ range, text } | null>

    // ---------- Keeping the answer in view ----------
    // The box sits over the page, so after a jump the page is scrolled until the answer isn't
    // behind it: just below the box when they share the right-hand side, centred otherwise.
    // It re-checks when the sentence arrives or the panels grow, unless the reader has
    // scrolled since, in which case it leaves the page alone.
    let focusOn = null; // a Range or element: what should stay visible
    let autoScrollY = null;
    function hiddenFromView(rect) {
      const box = windowEl.getBoundingClientRect();
      const underBox = rect.right > box.left - 8 && rect.left < box.right + 8;
      const top = underBox ? box.bottom + 16 : 16;
      return { top, underBox, hidden: rect.top < top || rect.bottom > innerHeight - 16 };
    }
    function reveal(force = false) {
      if (!focusOn || !(force || autoScrollY === null || Math.abs(scrollY - autoScrollY) < 3)) return;
      const rect = focusOn.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const { top, underBox, hidden } = hiddenFromView(rect);
      if (hidden) {
        const room = innerHeight - top - 16;
        const offset = underBox || rect.height > room ? top : (innerHeight - rect.height) / 2;
        scrollBy({ top: rect.top - offset, behavior: "instant" });
      }
      autoScrollY = scrollY;
    }
    const growth = new ResizeObserver(() => reveal());
    growth.observe(windowEl);

    // ---------- Word for word ----------
    let wordIndex = null;
    let words = { ranges: [], total: 0 };
    let wordAt = 0;

    const wordsFor = (q) => { const w = q.replace(/\s+/g, " ").trim(); return w.length > 28 ? `${w.slice(0, 27)}…` : w; };
    function wordsLabel() {
      const more = words.total > words.ranges.length ? ` (first ${words.ranges.length} shown)` : "";
      $(".words-label").textContent = `${wordAt + 1} of ${words.total} · “${wordsFor(input.value)}”${more}`;
    }

    function findWords(q) {
      if (!document.body) return;
      if (wordIndex && wordIndex[0]?.at[0]?.[0]?.isConnected === false) wordIndex = null;
      wordIndex ??= CtrlF.indexPage();
      words = CtrlF.findWords(q, wordIndex);
      wordAt = 0;
      paint("ctrlf-word", words.ranges);
      paint("ctrlf-word-now", []);
      wordsPanel.hidden = !words.total;
      if (words.total) $(".words-label").textContent = `${words.total} ${words.total === 1 ? "match" : "matches"} for “${wordsFor(q)}”`;
    }

    // Moves to a word match. `scroll`: "always" jumps to it, "if-needed" only when it's off
    // screen or behind the box (used while typing, so the page doesn't jump around).
    function stepWord(by, scroll = "always") {
      if (!words.ranges.length) return;
      wordAt = (wordAt + by + words.ranges.length) % words.ranges.length;
      const range = words.ranges[wordAt];
      paint("ctrlf-word-now", [range]);
      wordsLabel();
      if (scroll === "always" || hiddenFromView(range.getBoundingClientRect()).hidden) {
        range.startContainer.parentElement?.scrollIntoView({ block: "center" });
        focusOn = range;
        reveal(true);
      }
    }

    // As you type, like normal Ctrl+F: every match lights up at once, and the first one on or
    // below the screen becomes the current one.
    function liveWords() {
      cancelAnimationFrame(typing);
      typing = 0;
      const q = input.value;
      latest++; // the question changed, so a meaning search still running is out of date
      clearResults();
      meter.hidden = true;
      say();
      findWords(q);
      if (!words.ranges.length) {
        if (q.trim().length > 1 && !aiPlan()) say("No matches on this page.", "", "", "miss");
        return;
      }
      const onScreen = words.ranges.findIndex((r) => r.getBoundingClientRect().top >= 0);
      wordAt = 0;
      stepWord(Math.max(0, onScreen), "if-needed");
    }

    // ---------- Meaning matches ----------
    function clearResults() {
      matches = [];
      found = null;
      focusOn = null;
      paint("ctrlf-match", []);
      paint("ctrlf-sentence", []);
      sourcesPanel.hidden = true;
      quotePanel.hidden = true;
      aiPanel.hidden = true;
      comparePanel.hidden = true;
      planNote.hidden = true;
      prev.disabled = next.disabled = true;
    }

    // The sentence that answers, found by a second small Jev call, cached per chunk.
    function sentenceRange(chunk) {
      if (!sentenceOf.has(chunk.id)) {
        const sentences = CtrlF.sentences(chunk.text);
        const job = (sentences.length > 1
          ? ask("sentence", { question, sentences, path: chunk.path, engine: found?.engine }).then((r) => r?.result?.index ?? null)
          : Promise.resolve(0)
        ).then((index) => (index == null ? null : { range: CtrlF.rangeFor(chunk.els, sentences[index]), text: sentences[index] }))
          .catch(() => null);
        sentenceOf.set(chunk.id, job);
      }
      return sentenceOf.get(chunk.id);
    }

    function showSources(chunk, range) {
      const list = CtrlF.citationsFor(chunk.el, range);
      const ol = $("ol.sources");
      ol.replaceChildren();
      for (const s of list) {
        const li = document.createElement("li");
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = s.label;
        const body = document.createElement("span");
        const short = s.text.length > 150 ? `${s.text.slice(0, 147).replace(/\s+\S*$/, "")}…` : s.text;
        body.textContent = `${short} `;
        body.title = s.text;
        if (s.url) {
          const a = document.createElement("a");
          a.href = s.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "open ↗";
          body.append(a);
        }
        li.append(n, body);
        ol.append(li);
      }
      sourcesPanel.hidden = !list.length;
    }

    // Shows the sentence that answers inside the box, so it can be read without looking for
    // the highlight. Until Jev has picked the sentence, the start of the paragraph shows.
    function showQuote(chunk, picked) {
      const p = $(".quote-text");
      p.replaceChildren();
      // The sentence as Jev read it: table cells keep their separators, unlike the page text.
      const sentence = picked?.text?.replace(/\s+/g, " ").trim();
      if (sentence) {
        const mark = document.createElement("mark");
        mark.textContent = sentence;
        p.append(mark);
      } else {
        const text = chunk.text.replace(/\s+/g, " ").trim();
        p.textContent = text.length > 260 ? `${text.slice(0, 257).replace(/\s+\S*$/, "")}…` : text;
      }
      $(".quote-foot").textContent = chunk.path?.length ? chunk.path.join(" › ") : "";
      quotePanel.hidden = false;
    }

    const where = (i) => [matches.length > 1 ? `${i + 1} of ${matches.length}` : "", timing].filter(Boolean).join(" · ");

    // Scrolls to match i, highlights its paragraph now, and its sentence and sources as soon
    // as Jev has picked the sentence. False if the page changed under it.
    function show(i) {
      const chunk = matches[i];
      if (!chunk.el.isConnected) return false;
      current = i;
      paint("ctrlf-match", chunk.els.map((el) => {
        const r = new Range();
        r.selectNodeContents(el);
        return r;
      }));
      paint("ctrlf-sentence", []);
      chunk.el.scrollIntoView({ block: "center" }); // also scrolls any scrolling panel it sits in
      focusOn = chunk.el;
      reveal(true);
      say(verdict, where(i), sure, "ok");
      showQuote(chunk, null);
      const mine = latest;
      sentenceRange(chunk).then((picked) => {
        if (mine !== latest || matches[current] !== chunk) return;
        const range = picked?.range ?? null;
        if (range) {
          paint("ctrlf-sentence", [range]);
          focusOn = range;
        }
        showQuote(chunk, picked);
        showSources(chunk, range);
        reveal();
      });
      return true;
    }

    function step(by) {
      if (!matches.length) return;
      if (!show((current + by + matches.length) % matches.length)) search(question, { retried: true });
    }

    // ---------- AI answer ----------
    async function askAi(excerpts) {
      if (settings.aiProvider === "off" || !aiPlan()) return;
      const mine = latest;
      const label = { nemotron: settings.hasNebiusKey ? "Nemotron 3 Super" : "hosted AI", hosted: "hosted AI", local: "agy → grok → codex" }[settings.aiProvider] ?? "AI";
      aiPanel.hidden = false;
      const answer = $(".answer");
      const foot = $(".foot");
      aiPanel.querySelectorAll(".content .extra").forEach((b) => b.remove());
      answer.className = "answer muted dots";
      answer.textContent = "thinking";
      foot.textContent = label;
      const started = performance.now();
      const tick = setInterval(() => {
        if (mine === latest) foot.textContent = `${label} · ${((performance.now() - started) / 1000).toFixed(1)} s`;
      }, 100);
      let reply;
      try {
        reply = await ask("ask", { question, title: document.title, url: location.href, excerpts }, LIMITS.ask);
      } catch (err) {
        reply = { error: { code: "error", message: alive() ? err.message : PROBLEMS.reload() } };
      }
      clearInterval(tick);
      if (mine !== latest) return;
      answer.classList.remove("dots");
      if (reply?.result) {
        const { text, by, ms, tried, fellBackFrom } = reply.result;
        answer.className = "answer";
        answer.textContent = text;
        const skipped = (tried ?? []).filter((t) => !t.ok).map((t) => `${t.tool} didn't answer`);
        const instead = fellBackFrom === "nemotron" ? ["no Nebius key, so hosted AI"] : [];
        foot.textContent = [`${by} · ${(ms / 1000).toFixed(1)} s`, ...skipped, ...instead].join(" · ");
        return;
      }
      const e = reply?.error ?? {};
      answer.className = "answer muted";
      foot.textContent = "";
      answer.textContent = (AI_PROBLEMS[e.code] ?? AI_PROBLEMS.default)(e);
      if (AI_NEEDS_SETTINGS.has(e.code)) answer.after(settingsButton());
    }

    function excerptsFor(result) {
      const picks = matches.length ? matches : result.top.slice(0, 3).map((t) => byId.get(t.id)).filter(Boolean);
      return picks.map((c) => ({ text: c.text, path: c.path }));
    }

    // ---------- Compare (hidden: Option+Enter) ----------
    function showCompare(jev, other) {
      comparePanel.hidden = false;
      const vs = $(".vs");
      const verdict = $(".verdict");
      if (other.error) {
        vs.replaceChildren();
        verdict.textContent = other.error.code === "no-bridge"
          ? "Compare needs an AI. The helper for this Mac isn't installed and no hosted key is saved."
          : (AI_PROBLEMS[other.error.code] ?? AI_PROBLEMS.default)(other.error);
        return;
      }
      const o = other.result;
      const most = Math.max(jev.ms, o.ms, 1);
      const preview = (id) => {
        const c = byId.get(id);
        return c ? `${id} “${c.text.slice(0, 60)}…”` : `${id || "?"} (not a line on this page)`;
      };
      const row = (name, ms, id, answered, other) => `
        <b>${name}</b><div class="bar${other ? " other" : ""}"><i style="width:${Math.max(3, (ms / most) * 100)}%"></i></div><span>${ms.toLocaleString()} ms</span>
        <div class="pickline">${answered ? "" : "says not answered · "}${escapeHtml(preview(id))}</div>`;
      const first = escapeHtml(jev.short ?? "Jev");
      vs.innerHTML = row(first, jev.ms, jev.top[0]?.id, jev.exists >= NOT_FOUND_BELOW, false)
        + row(escapeHtml((o.short ?? o.by.split(" ")[0]).slice(0, 9)), o.ms, o.id, o.answered, true);
      const same = o.id === jev.top[0]?.id;
      const ratio = o.ms / Math.max(jev.ms, 1);
      verdict.textContent = `${same ? "✓ Same paragraph" : "✗ Different paragraphs"} · ${first} ${ratio >= 1 ? `${ratio.toFixed(1)}× faster` : `${(1 / ratio).toFixed(1)}× slower`} · other: ${o.by}`;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }

    // ---------- Search by meaning ----------
    async function search(q, options = {}) {
      const mine = latest + 1;
      // Seconds since Enter, so a slow answer never looks frozen.
      const began = performance.now();
      const clock = setInterval(() => {
        if (latest !== mine || !status.querySelector(".busy")) return clearInterval(clock);
        const s = Math.round((performance.now() - began) / 1000);
        say(s >= 15 ? "searching (slow right now)" : "searching", `${s} s`, "", "busy");
      }, 1000);
      try {
        await searchNow(q, options);
      } catch (err) {
        // Anything unexpected ends in a message, never an endless spinner.
        if (latest !== mine) return;
        console.warn("Pareto search failed:", err);
        meter.hidden = true;
        comparePanel.hidden = true;
        const problem = problemOf(err);
        say(problem.code === "jev-error" ? `Something went wrong: ${err?.message ?? err}` : PROBLEMS[problem.code](), "", "", "err");
      } finally {
        clearInterval(clock);
      }
    }

    async function searchNow(q, { compare = false, retried = false } = {}) {
      const started = performance.now();
      const mine = ++latest;
      question = q;
      sentenceOf.clear();
      clearResults();
      setMeter(0, true);
      say("searching", "", "", "busy");
      await readPage();
      if (pageChanged()) await rereadPage();
      if (mine !== latest) return;
      if (!toScore.length) {
        meter.hidden = true;
        say(unreadable ? "Couldn't read this page's text. Word-for-word find still works." : "There's no text on this page to search.", "", "", "err");
        return;
      }

      const jevReply = ask("search", { question: q, chunks: toScore }, LIMITS.search);
      const otherReply = compare ? ask("compare", { question: q, chunks: toScore }, LIMITS.compare).catch((err) => ({ error: { code: "error", message: err.message } })) : null;
      if (compare) {
        comparePanel.hidden = false;
        $(".vs").replaceChildren();
        $(".verdict").textContent = "Asking both…";
      }
      findWords(q); // on this computer, while Jev is working

      let reply;
      try {
        reply = await jevReply;
      } catch (err) {
        if (mine !== latest) return;
        setMeter(0);
        const problem = problemOf(err);
        say(problem.code === "jev-error" ? `Something went wrong: ${err.message}` : PROBLEMS[problem.code](), "", "", "err");
        return;
      }
      if (mine !== latest) return;

      if (reply?.error) {
        setMeter(0);
        comparePanel.hidden = true;
        say((PROBLEMS[reply.error.code] ?? PROBLEMS["jev-error"])(reply.error), "", "", "err");
        if (reply.error.code === "no-key" || reply.error.code === "bad-key") status.append(settingsButton());
        if (reply.error.code === "free-plan") planNote.hidden = false;
        if (words.total) stepWord(0);
        return;
      }

      found = reply.result;
      const { exists, top, ms: jevMs, calls, short: engine = "Jev", because } = found;
      const pct = Math.round(exists * 100);
      const parts = (calls > 1 ? ` · asked in ${calls} parts` : "") + (because && BECAUSE[because] ? ` · ${BECAUSE[because]}` : "");
      verdict = " this page answers it";
      const elapsed = () => Math.round(performance.now() - started);
      let ms;
      matches = exists >= NOT_FOUND_BELOW
        ? top.filter((t, i) => i === 0 || t.score >= MIN_SCORE).map((t) => byId.get(t.id)).filter(Boolean)
        : [];
      setMeter(exists);
      if (!matches.length) {
        ms = elapsed();
        say("Not found on this page", `${pct}% sure it's here · ${engine} · ${ms} ms${parts}`, "", "miss");
        if (words.total) stepWord(0); // at least show where the words are
      } else {
        prev.disabled = next.disabled = matches.length < 2;
        sure = `${pct}% sure`;
        timing = "";
        if (!show(0)) {
          // The page re-drew itself between reading and answering: read it again, once.
          if (!retried) return searchNow(q, { compare, retried: true });
          clearResults();
          say("This page keeps changing. Try again in a moment.", "", "", "err");
          return;
        }
        // Enter to highlight: timed once the highlight is on and the page has scrolled.
        // The screen paints it within the next frame, about 16 ms later.
        ms = elapsed();
        timing = `${engine} · ${ms} ms${parts}`;
        say(verdict, where(0), sure, "ok");
      }

      console.log(`Pareto: "${q}" — ${pct}% sure, Enter to highlight ${ms ?? "-"} ms, ${engine} ${jevMs} ms, ${calls} call(s), ${words.total} word-for-word. Top 5:`);
      console.table(top.map((t) => ({ id: t.id, score: t.score.toFixed(3), text: byId.get(t.id)?.text.slice(0, 100) })));

      if (settings.aiAuto) askAi(excerptsFor(found));
      else if (settings.aiProvider !== "off") {
        aiPanel.hidden = false;
        $(".answer").className = "answer muted";
        $(".answer").textContent = "Press ask again for a written answer.";
        $(".foot").textContent = "";
      }
      if (otherReply) {
        const other = await otherReply;
        if (mine === latest) showCompare(found, other);
      }
    }

    // ---------- Think harder (⌘ Enter): Nemotron 3 Ultra ----------
    // Ultra gets the whole page, reasons it through, writes the answer, and names the lines it
    // relied on. Those are highlighted like a normal search's matches, so ↑↓, the sentence and
    // the sources work the same. It takes longer, so the answer panel says what it's doing as
    // the reply streams in.
    let deepStatus = null; // while Ultra works: (progress) => void
    async function thinkHarder(q) {
      const mine = latest + 1;
      try {
        await thinkHarderNow(q);
      } catch (err) {
        if (latest !== mine) return;
        console.warn("Pareto think harder failed:", err);
        meter.hidden = true;
        deepStatus = null;
        say(`Something went wrong: ${err?.message ?? err}`, "", "", "err");
      }
    }

    async function thinkHarderNow(q) {
      const mine = ++latest;
      question = q;
      sentenceOf.clear();
      clearResults();
      setMeter(0, true);
      say("thinking harder", "Nemotron 3 Ultra", "", "busy");
      await readPage();
      if (pageChanged()) await rereadPage();
      if (mine !== latest) return;
      if (!toScore.length) {
        meter.hidden = true;
        say(unreadable ? "Couldn't read this page's text. Word-for-word find still works." : "There's no text on this page to search.", "", "", "err");
        return;
      }
      findWords(q); // on this computer, while Ultra is working

      aiPanel.hidden = false;
      aiPanel.querySelectorAll(".content .extra").forEach((b) => b.remove());
      const answer = $(".answer");
      const foot = $(".foot");
      answer.className = "answer muted dots";
      answer.textContent = "thinking";
      const askAgain = $(".ask");
      askAgain.hidden = true; // asking Super mid-think would replace Ultra's answer
      const started = performance.now();
      const seconds = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;
      let doing = "reading the page";
      const tick = setInterval(() => {
        if (mine !== latest) return clearInterval(tick);
        foot.textContent = `Nemotron 3 Ultra · ${doing} · ${seconds()}`;
        say("thinking harder", seconds(), "", "busy");
      }, 100);
      deepStatus = (p) => {
        if (mine !== latest) return;
        doing = p.phase === "writing" ? "writing" : `thinking · ${wordCount(p.thoughtChars)}`;
      };

      let reply;
      try {
        reply = await ask("deep", { question: q, title: document.title, url: location.href, chunks: toScore }, LIMITS.deep);
      } catch (err) {
        reply = { error: { code: err?.code === "slow" ? "timeout" : "error", message: alive() ? err?.message : PROBLEMS.reload() } };
      }
      clearInterval(tick);
      deepStatus = null;
      askAgain.hidden = false;
      if (mine !== latest) return;
      answer.classList.remove("dots");
      meter.hidden = true;

      if (!reply?.result) {
        const e = { service: "Nemotron 3 Ultra", ...(reply?.error ?? {}) };
        say("Think harder didn't finish", "", "", "err");
        answer.className = "answer muted";
        foot.textContent = "";
        answer.textContent = (AI_PROBLEMS[e.code] ?? AI_PROBLEMS.default)(e);
        if (AI_NEEDS_SETTINGS.has(e.code)) answer.after(settingsButton());
        if (words.total) stepWord(0);
        return;
      }

      const { text, lines, by, ms, thoughtChars } = reply.result;
      answer.className = "answer";
      answer.textContent = text;
      foot.textContent = [`${by} · ${(ms / 1000).toFixed(1)} s`, thoughtChars ? `thought ${wordCount(thoughtChars)}` : ""].filter(Boolean).join(" · ");
      // Ultra's lines stand in for a search's matches. The sentence in each is picked by Jev
      // when there's a Jev key, otherwise by Lightning.
      found = { engine: settings.hasJevKey ? "jev" : "nemotron", exists: lines.length ? 1 : 0, top: lines.map((id) => ({ id, score: 1 })), short: "Ultra", ms };
      matches = lines.map((id) => byId.get(id)).filter(Boolean);
      if (!matches.length) {
        say("Ultra didn't point to a part of this page", `Ultra · ${(ms / 1000).toFixed(1)} s`, "", "miss");
        if (words.total) stepWord(0);
        return;
      }
      prev.disabled = next.disabled = matches.length < 2;
      sure = "";
      verdict = "Ultra used this part";
      timing = `Ultra · ${(ms / 1000).toFixed(1)} s`;
      if (!show(0)) say("This page changed while Ultra was thinking. Try again.", "", "", "err");
    }
    // Reasoning length in words, roughly: about six characters a word.
    const wordCount = (chars) => { const n = Math.max(1, Math.round(chars / 6)); return `${n.toLocaleString()} ${n === 1 ? "word" : "words"}`; };

    // ---------- Wiring ----------
    function close() {
      latest++; // a search still running can no longer show its answer
      growth.disconnect();
      for (const [name, layer] of Object.entries(layers)) {
        if (CSS.highlights.get(name) === layer) CSS.highlights.delete(name);
      }
      host.remove();
      box = null;
    }

    function focus() {
      input.focus();
      input.select();
    }

    // Stop keys typed in the box from reaching the page's own shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) {
      host.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type !== "keydown") return;
        if (event.key === "Escape") close();
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const by = event.key === "ArrowDown" ? 1 : -1;
          if ((event.shiftKey || !matches.length) && words.ranges.length) {
            event.preventDefault();
            stepWord(by);
          } else if (!event.shiftKey && matches.length) {
            event.preventDefault();
            step(by);
          }
        }
      });
    }
    // Enter searches by meaning on the AI plan, Option+Enter (Alt+Enter) also runs compare,
    // and ⌘ Enter (Ctrl+Enter) thinks harder with Nemotron 3 Ultra. On the free plan, Enter
    // steps through the word matches like Ctrl+F.
    // This listener sits on the input itself, because the closed shadow root hides the input
    // from the host's listeners.
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      if (typing) liveWords(); // catch up on the last keystroke first, so it can't cancel this search
      if (aiPlan()) return event.metaKey || event.ctrlKey ? thinkHarder(q) : search(q, { compare: event.altKey });
      if (words.ranges.length) stepWord(event.shiftKey ? -1 : 1);
      planNote.hidden = false;
    });
    let typing = 0;
    input.addEventListener("input", () => {
      cancelAnimationFrame(typing);
      typing = requestAnimationFrame(liveWords);
    });
    form.addEventListener("submit", (event) => event.preventDefault());

    prev.addEventListener("click", () => step(-1));
    next.addEventListener("click", () => step(1));
    $(".word-prev").addEventListener("click", () => stepWord(-1));
    $(".word-next").addEventListener("click", () => stepWord(1));
    $(".ask").addEventListener("click", () => found && askAi(excerptsFor(found)));
    $(".close").addEventListener("click", close);
    $(".jump").addEventListener("click", () => {
      const chunk = matches[current];
      if (!chunk) return;
      chunk.el.scrollIntoView({ block: "center" });
      focusOn = focusOn ?? chunk.el;
      reveal(true);
    });
    $(".upgrade").addEventListener("click", (event) => {
      event.preventDefault();
      ask("openUpgrade");
    });

    // Drag the window by the row around the question, or by the key hints at the bottom.
    windowEl.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".row, .hints") || event.target.closest("button, input")) return;
      event.preventDefault(); // keep the question focused
      const rect = stage.getBoundingClientRect();
      const dx = event.clientX - rect.left;
      const dy = event.clientY - rect.top;
      const move = (e) => {
        stage.style.left = `${Math.min(Math.max(0, e.clientX - dx), innerWidth - 60)}px`;
        stage.style.top = `${Math.min(Math.max(0, e.clientY - dy), innerHeight - 30)}px`;
        stage.style.right = "auto";
      };
      const stop = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", stop);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", stop);
    });

    document.documentElement.appendChild(host);
    focus();
    // Read the page, and index its words for typing, once the box is on screen.
    readPage().then(() => {
      if (box && !wordIndex) setTimeout(() => { wordIndex ??= CtrlF.indexPage(); }, 0);
    });
    return { focus, setLook: (l) => { stage.dataset.look = l; }, progress: (p) => deepStatus?.(p) };
  }
})();
