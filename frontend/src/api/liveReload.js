// Live reloads for one view, driven by the change feed ("dcim-data-changed", ./changes.js). Pure (no React), so
// node --test can import it; ./useLiveReload.js wires it to a component.
//
// One reload at a time: a change that arrives while the view reloads, or while one of its own saves runs (during()),
// is queued and runs exactly ONE more reload once that is over, with every domain that arrived meanwhile. So a burst
// of changes never becomes a storm of reloads, and a reload never lands in the middle of a save and puts back what
// the save is replacing. isBlocked() can hold reloads for other reasons (an open form the view protects itself).
export function createLiveReload(reload, { isBlocked = () => false } = {}) {
  let running = false;
  let saving = 0;
  let queued = null;   // the domains waiting for the next reload (a Set), or null
  function pump() {
    if (running || !queued || saving > 0 || isBlocked()) return;
    const domains = [...queued];
    queued = null;
    running = true;
    Promise.resolve()
      .then(() => reload(domains))
      .catch(() => { /* the view shows its own load errors; the next change or poll tries again */ })
      .finally(() => { running = false; pump(); });
  }
  return {
    // A change in these domains (the feed's event detail).
    trigger(domains = []) {
      queued = new Set([...(queued || []), ...domains]);
      pump();
    },
    // Runs a save of this view: changes that arrive meanwhile wait until it is over.
    async during(save) {
      saving++;
      try { return await save(); }
      finally { saving--; pump(); }
    },
    // Runs a queued reload now if nothing holds it any more (after isBlocked() turned false).
    flush: pump,
    pending: () => queued != null,
    busy: () => running || saving > 0,
  };
}
