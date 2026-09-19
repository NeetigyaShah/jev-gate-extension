// Atomic DOM snapshot: visible interactive controls -> indexed element table.
// Mirrors jev-ultrafast snapshot.js semantics: one call, live refs kept in-page.
// Wrapped so re-injection (background fallback) reuses one map + one listener
// instead of creating a second copy with an empty ref table (stale-element bug).
if (!window.__jevGate) {
  window.__jevGate = (() => {
const SELECTOR = [
  'a', 'button', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]',
  '[contenteditable="true"]', '[tabindex="0"]',
].join(', ');

const MAX_ELEMENTS = 90;
const MAX_DUP_TEXT = 3;
const nodeByIndex = new Map();

function isVisible(el) {
  if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true' && !el.getAttribute('aria-label')) return false;
  const r = el.getBoundingClientRect();
  if (!r || r.width === 0 || r.height === 0) return false;
  if (el.offsetParent === null && el.tagName !== 'BODY') return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
}

function labelFor(el) {
  return (
    el.getAttribute('aria-label') ||
    el.innerText ||
    el.value ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.getAttribute('name') ||
    ''
  );
}

function describe(el) {
  const text = labelFor(el).replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    type: el.type || '',
    text,
    value: (el.value || '').slice(0, 120),
    href: el.href || '',
  };
}

// Priority: labelled, text-bearing, semantic controls first. Star toggles and
// other identical repeated controls are capped so they cannot crowd out the
// real targets (Gmail inbox rows are <tr tabindex=0>, not <a>/<button>).
function score(el, d) {
  let s = 0;
  if (['a', 'button', 'input', 'select', 'textarea'].includes(d.tag)) s += 3;
  if (el.getAttribute('role')) s += 2;
  if (d.text) s += 2;
  if (el.getAttribute('aria-label')) s += 1;
  if (el.hasAttribute('tabindex')) s += 1;
  if (d.text.length > 25) s += 1;
  return s;
}

// Visible prose, so done_check can verify outcomes that are not clickable
// (result counts, confirmation text). Interactive-only state cannot.
function pageText() {
  const main = document.querySelector('main') || document.body;
  return (main?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 700);
}

function snapshot() {
  nodeByIndex.clear();
  const roots = [document];
  document.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) roots.push(el.shadowRoot);
  });

  const seen = new Set();
  const candidates = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll(SELECTOR)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const d = describe(el);
      candidates.push({ el, d, s: score(el, d) });
    }
  }

  // List-row pass: repeated sibling rows (<tr>/<li>) are how inboxes, tables and
  // feeds render clickable items. Depends on generic structure, not on
  // site-specific attributes (Gmail rows carry no role/tabindex we can rely on).
  const rowSeen = new Set();
  for (const root of roots) {
    for (const el of root.querySelectorAll('tr, li')) {
      if (rowSeen.has(el)) continue;
      if (!isVisible(el)) continue;
      const d = describe(el);
      if (d.text.length < 12) continue;
      const parent = el.parentElement;
      if (!parent) continue;
      const sameTag = parent.querySelectorAll(`:scope > ${el.tagName}`).length;
      if (sameTag < 3) continue;
      // If the row merely wraps a real link, that link is already a candidate and
      // is the only element a click will follow. Star toggles (role=button) are
      // NOT a reason to skip: Gmail rows contain one and are still clickable.
      if (el.querySelector('a[href]')) continue;
      // Keep the outermost repeating row only.
      let p = parent;
      let nested = false;
      while (p) {
        if (rowSeen.has(p)) { nested = true; break; }
        p = p.parentElement;
      }
      if (nested) continue;
      rowSeen.add(el);
      candidates.push({ el, d, s: score(el, d) + 4 });
    }
  }

  // Pointer-block pass: div-based clickable blocks (cursor:pointer). Keep the
  // outermost block so a nested icon does not shadow the whole row.
  const ptrSeen = new Set();
  for (const root of roots) {
    for (const el of root.querySelectorAll('div, section, article, td')) {
      if (ptrSeen.has(el)) continue;
      if (!isVisible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.cursor !== 'pointer') continue;
      if (el.childElementCount < 2) continue;
      const d = describe(el);
      if (d.text.length < 15) continue;
      if (el.querySelector('a[href]')) continue;
      let p = el.parentElement;
      let nested = false;
      while (p) {
        if (ptrSeen.has(p)) { nested = true; break; }
        p = p.parentElement;
      }
      if (nested) continue;
      ptrSeen.add(el);
      candidates.push({ el, d, s: score(el, d) + 3 });
    }
  }

  candidates.sort((a, b) => b.s - a.s);

  const dupCount = new Map();
  const elements = [];
  for (const c of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;
    const key = c.d.text || `__${c.d.tag}`;
    const n = (dupCount.get(key) || 0) + 1;
    if (c.d.text && n > MAX_DUP_TEXT) continue;
    dupCount.set(key, n);
    const id = elements.length + 1;
    nodeByIndex.set(id, c.el);
    elements.push({ id, ...c.d });
  }

  return { url: location.href, title: document.title.slice(0, 120), text: pageText(), elements };
}

function execute(action) {
  const key = typeof action.target === 'string' ? Number(action.target) : action.target;
  const el = nodeByIndex.get(key);
  if (!el || !el.isConnected) return { ok: false, error: 'stale-element' };
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { ok: false, error: 'zero-size' };
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    return { ok: false, error: `occluded-by-${top.tagName}` };
  }
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  } catch (_) {
    el.scrollIntoView();
  }
  if (action.op === 'CLICK') {
    // A container click only works if the page delegates the event. If this
    // element merely wraps one link/button, that child is what actually acts.
    let target = el;
    const semantic = ['a', 'button', 'input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) || el.getAttribute('role');
    if (!semantic && !el.hasAttribute('jsaction')) {
      const inner = Array.from(el.querySelectorAll('a[href]')).filter((n) => n.getBoundingClientRect().width > 0);
      if (inner.length === 1) target = inner[0];
    }
    const r2 = target.getBoundingClientRect();
    const cx2 = r2.left + r2.width / 2;
    const cy2 = r2.top + r2.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx2, clientY: cy2, button: 0 };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', base));
      target.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mouseup', base));
      target.dispatchEvent(new MouseEvent('click', base));
      if (target instanceof HTMLAnchorElement && target.href) {
        // Synthetic events do not trigger default navigation for every case.
        if (target.target === '_blank') window.open(target.href, '_blank');
      }
      if (typeof target.focus === 'function') target.focus({ preventScroll: true });
      if (target !== el) el.click?.();
    } catch (_) {
      target.click();
    }
    return { ok: true };
  }
  if (action.op === 'TYPE_TEXT') {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = action.text ?? '';
    } else {
      el.value = action.text ?? '';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (action.op === 'SELECT') {
    el.value = action.text ?? '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  return { ok: false, error: `unsupported-op-${action.op}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'SNAPSHOT') {
    try {
      sendResponse({ ok: true, snapshot: snapshot() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
  if (msg?.type === 'EXECUTE') {
    try {
      sendResponse(execute(msg.action));
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
});

return { snapshot, execute };
  })();
}
