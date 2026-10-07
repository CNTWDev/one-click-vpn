// Runs inside the page (page.evaluate). Reports layout defects a person would see at a glance:
//   overflow: the page scrolls sideways
//   spill:    text runs past the edge of its own box (and nothing clips it with an ellipsis or scroller)
//   overlap:  two pieces of visible content (text, controls, bars, icons) paint on top of each other
// Elements can opt out with data-layout-ignore (decorative maps, intentionally stacked art).
export function auditLayout() {
  const issues = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) issues.push({ kind: "overflow", detail: `page ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport` });

  const describe = (el) => {
    const parts = [];
    for (let node = el, depth = 0; node && node !== document.body && depth < 3; node = node.parentElement, depth++) {
      const cls = typeof node.className === "string" && node.className.trim() ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      parts.unshift(node.tagName.toLowerCase() + cls);
    }
    const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return parts.join(" > ") + (text ? ` "${text}"` : "");
  };
  const ignored = (el) => !!el.closest("[data-layout-ignore], .fleet-map, [aria-hidden=true], .sr-only");
  const visible = (el) => {
    // Content of a collapsed <details> still reports layout boxes in Chromium, but nobody can see it.
    const closed = el.closest("details:not([open])");
    if (closed && !el.closest("summary")) return false;
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && !/inset\(50%\)/.test(getComputedStyle(el).clipPath);
  };
  // Clipping ancestor: content painted outside it is not visible, so it cannot collide with anything.
  const clipRect = (el) => {
    let rect = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX !== "visible" || s.overflowY !== "visible" || s.contain.includes("paint")) {
        const r = node.getBoundingClientRect();
        rect = { left: Math.max(rect.left, r.left), top: Math.max(rect.top, r.top), right: Math.min(rect.right, r.right), bottom: Math.min(rect.bottom, r.bottom) };
      }
    }
    return rect;
  };
  const scrollable = (el) => { for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) { const x = getComputedStyle(node).overflowX; if (x === "auto" || x === "scroll") return true; } return false; };
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

  // 1. Text spilling out of its own box.
  const blocks = [...document.querySelectorAll("body *")].filter((el) => {
    if (ignored(el) || !visible(el)) return false;
    const s = getComputedStyle(el);
    if (s.display === "inline" || s.display === "contents") return false;
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  });
  for (const el of blocks) {
    const s = getComputedStyle(el);
    if (s.overflowX !== "visible" || s.textOverflow === "ellipsis") continue;
    const box = el.getBoundingClientRect();
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.right > box.right + 2 || r.left < box.left - 2) { issues.push({ kind: "spill", detail: `${describe(el)} text is ${Math.round(r.width)}px wide in a ${Math.round(box.width)}px box` }); break; }
      }
    }
  }

  // 2. Overlapping content. "Pieces" are text runs plus things that paint on their own.
  const pieces = [];
  const leafSelector = "button, input, select, textarea, img, svg, canvas, video, progress, meter, [role=progressbar], .meter i, .pill, .badge, .tag";
  for (const el of document.querySelectorAll(leafSelector)) {
    if (ignored(el) || !visible(el) || el.parentElement?.closest(leafSelector)) continue;
    const r = el.getBoundingClientRect();
    // Large graphics (maps, illustrations) are backdrops that captions sit on by design.
    if (/^(svg|img|canvas|video)$/i.test(el.tagName) && r.width >= 120 && r.height >= 120) continue;
    const clip = clipRect(el.parentElement);
    // A control cut off by an overflow:hidden box (not a scroller the user can scroll) is partly unusable.
    const partlyShown = r.right > clip.left && r.left < clip.right;
    if (partlyShown && (r.right > clip.right + 2 || r.left < clip.left - 2) && !scrollable(el)) issues.push({ kind: "clipped", detail: `${describe(el)} is cut off (${Math.round(r.left)}–${Math.round(r.right)}px, visible ${Math.round(clip.left)}–${Math.round(clip.right)}px)` });
    pieces.push({ el, rect: intersect(r, clip) });
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el || ignored(el) || el.closest(leafSelector) || !visible(el)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const clip = clipRect(el);
    for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) pieces.push({ el, rect: intersect(r, clip) });
  }
  // Fixed/sticky layers (toasts, sticky headers, modals) legitimately sit on top of content.
  const layer = (el) => { for (let node = el; node; node = node.parentElement) { const p = getComputedStyle(node).position; if (p === "fixed" || p === "sticky") return node; } return null; };
  const seen = new Set();
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i];
    if (a.rect.right - a.rect.left < 1 || a.rect.bottom - a.rect.top < 1) continue;
    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const o = intersect(a.rect, b.rect);
      const w = o.right - o.left, h = o.bottom - o.top;
      // Small tolerance: glyph boxes include line-height padding, so 3px overlaps are normal typography.
      if (w <= 3 || h <= 3) continue;
      if (layer(a.el) !== layer(b.el)) continue;
      const key = describe(a.el) + "|" + describe(b.el);
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({ kind: "overlap", detail: `${describe(a.el)} overlaps ${describe(b.el)} by ${Math.round(w)}×${Math.round(h)}px` });
    }
  }
  // 3. Words glued together ("Last activity3 minutes ago", "SyncAwaiting"): two text runs that were concatenated
  //    without a space and sit flush against each other on the same line. Measured visually, so CSS gaps count.
  const runs = [];
  const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = textWalker.nextNode(); n; n = textWalker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el || ignored(el) || el.closest("option, script, style, select") || !visible(el)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    if (rects.length) runs.push({ el, text: n.textContent, first: rects[0], last: rects[rects.length - 1] });
  }
  const word = /[\p{L}\p{N}]/u;
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1], b = runs[i];
    if (!word.test(a.text.at(-1)) || !word.test(b.text[0])) continue;
    // CJK needs no spaces between words.
    if (/[\u3400-\u9fff]/u.test(a.text.at(-1)) || /[\u3400-\u9fff]/u.test(b.text[0])) continue;
    // Deliberate joins: version prefixes ("v" + "2") and two-tone uppercase wordmarks ("VEIL" + "BIRD").
    if (/(^|\W)v$/.test(a.text) && /^\d/.test(b.text)) continue;
    if (/^[A-Z]+$/.test(a.text.trim()) && /^[A-Z]+$/.test(b.text.trim())) continue;
    const sameLine = Math.abs(a.last.top - b.first.top) < 3 && Math.abs(a.last.bottom - b.first.bottom) < 3;
    if (sameLine && b.first.left - a.last.right < 2 && b.first.left - a.last.right > -2) issues.push({ kind: "glued", detail: `"${a.text.slice(-24).trim()}" runs into "${b.text.slice(0, 24).trim()}" (${describe(b.el)})` });
  }
  return issues;
}
