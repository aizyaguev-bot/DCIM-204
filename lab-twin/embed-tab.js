/* Lab Manager ↔ Digital Twin bridge (no-build fallback).
 * Injected into frontend/dist/index.html by install-twin.sh when the React app cannot be rebuilt (no npm on the VM).
 * Adds a "3D Twin" tab next to Dashboard / DCIM / Sync Map that shows /twin/index.html?embed=1 in place of the page body.
 * When the React source (App.jsx) already has the twin tab (rebuilt frontend), this script does nothing.
 */
(() => {
  'use strict';
  const LABEL = '3D Twin';
  let frame = null, active = false;

  function tabBar() {
    const btns = [...document.querySelectorAll('button')];
    const dash = btns.find(b => b.textContent.trim() === 'Dashboard' && b.className.includes('border-b-2'));
    return dash ? dash.parentElement : null;
  }
  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.title = '3D Digital Twin'; frame.src = '/twin/index.html?embed=1'; frame.allow = 'fullscreen';
    Object.assign(frame.style, { position: 'fixed', left: 0, right: 0, bottom: 0, border: 0, width: '100%', background: '#0a0a0c', zIndex: 20, display: 'none' });
    document.body.appendChild(frame); return frame;
  }
  function place() {
    const bar = tabBar(); if (!bar || !frame) return;
    const r = bar.getBoundingClientRect(); frame.style.top = Math.round(r.bottom + 1) + 'px'; frame.style.height = `calc(100vh - ${Math.round(r.bottom + 1)}px)`;
  }
  function setActive(on) {
    active = on; const f = ensureFrame(); f.style.display = on ? 'block' : 'none'; place();
    const bar = tabBar(); if (!bar) return;
    [...bar.querySelectorAll('button')].forEach(b => {
      const isTwin = b.dataset.twinTab === '1';
      if (isTwin) { b.className = base(bar) + (on ? ' text-nv-400 border-nv-400 bg-nv-400/5' : ' text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/40'); }
      else if (on) { b.classList.remove('text-nv-400', 'border-nv-400', 'bg-nv-400/5'); b.classList.add('text-zinc-500', 'border-transparent'); }
    });
  }
  function base(bar) { const any = bar.querySelector('button:not([data-twin-tab])'); return any ? any.className.replace(/\b(text-nv-400|border-nv-400|bg-nv-400\/5|text-zinc-500|border-transparent|hover:text-zinc-300|hover:bg-zinc-800\/40)\b/g, '').replace(/\s+/g, ' ').trim() : 'px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition'; }
  function inject() {
    const bar = tabBar(); if (!bar) return;
    if ([...bar.querySelectorAll('button')].some(b => b.textContent.trim() === LABEL && !b.dataset.twinTab)) return; // real React tab exists → do nothing
    if (bar.querySelector('[data-twin-tab]')) { if (active) place(); return; }
    const b = document.createElement('button'); b.textContent = LABEL; b.dataset.twinTab = '1';
    b.className = base(bar) + ' text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/40';
    b.onclick = () => setActive(true);
    bar.appendChild(b);
    [...bar.querySelectorAll('button:not([data-twin-tab])')].forEach(o => o.addEventListener('click', () => setActive(false)));
    if (active) setActive(true);
  }
  const mo = new MutationObserver(() => inject());
  window.addEventListener('DOMContentLoaded', () => { inject(); mo.observe(document.body, { childList: true, subtree: true }); });
  window.addEventListener('resize', place);
  if (document.readyState !== 'loading') { inject(); mo.observe(document.body, { childList: true, subtree: true }); }
})();
