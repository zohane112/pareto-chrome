// Citations: reads which sources a sentence or paragraph cites, from its footnote markers
// ([12] on Wikipedia, or any superscript link to a note on the same page). Read from the
// page only; nothing is sent anywhere. Kept separate so the academic tool can reuse it.

(() => {
  const CtrlF = (globalThis.CtrlF ??= {});

  const MAX = 6;
  const MAX_TEXT = 320;
  const BACKLINKS = ".mw-cite-backlink, [role=doc-backlink], a[href^='#cite_ref'], a[href^='#fnref']";

  const tidy = (text) => text.replace(/\s+/g, " ").replace(/^[\s^↑]+/, "").trim();

  function markersIn(el) {
    const all = [...el.querySelectorAll("sup, [role=doc-noteref]")].filter(CtrlF.isMarker);
    return all.filter((m) => !all.some((o) => o !== m && o.contains(m)));
  }

  function targetOf(marker) {
    const link = marker.matches("a") ? marker : marker.querySelector("a[href*='#']");
    if (!link?.hash) return null;
    try {
      return document.getElementById(decodeURIComponent(link.hash.slice(1)));
    } catch {
      return null;
    }
  }

  function textOf(el) {
    const copy = el.cloneNode(true);
    copy.querySelectorAll(BACKLINKS).forEach((b) => b.remove());
    return tidy(copy.textContent);
  }

  function firstLink(...els) {
    for (const el of els) {
      const links = [...(el?.querySelectorAll("a[href]") ?? [])].filter((a) => /^https?:/.test(a.href) && a.host !== location.host);
      const best = links.find((a) => a.matches(".external, [rel~=nofollow]")) ?? links[0];
      if (best) return best.href;
    }
    return null;
  }

  // One source: its label ("12"), its text, and a link out when it has one.
  // A short note like "Russell & Norvig 2021, p. 5" that points on to a full entry in the
  // page's bibliography gets that entry's text too.
  function source(marker) {
    const target = targetOf(marker);
    if (!target) return null;
    const body = target.querySelector(".reference-text") ?? target;
    let text = textOf(body);
    let full = null;
    const onward = body.querySelector("a[href^='#']:not([href^='#cite_ref'])");
    if (text.length < 120 && onward) {
      full = targetOf(onward);
      if (full && !full.contains(body)) text = `${text} — ${textOf(full)}`;
      else full = null;
    }
    const label = tidy(marker.textContent).replace(/^\[|\]$/g, "") || "•";
    return {
      id: target.id,
      label,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
      url: firstLink(body, full),
      target,
    };
  }

  // Sources for a match. With a sentence range: the markers inside the sentence, or, when
  // it has none, the next marker after it in the paragraph. Wikipedia puts a citation after
  // the text it supports. With no range: every marker in the element.
  function citationsFor(el, range = null) {
    const markers = markersIn(el);
    let chosen = markers;
    if (range) {
      chosen = markers.filter((m) => range.intersectsNode(m));
      if (!chosen.length) {
        const after = markers.find((m) => range.comparePoint(m, 0) === 1);
        chosen = after ? [after] : [];
      }
    }
    const seen = new Set();
    const out = [];
    for (const m of chosen) {
      const s = source(m);
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
      if (out.length === MAX) break;
    }
    return out;
  }

  CtrlF.citationsFor = citationsFor;
})();
