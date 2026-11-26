// The window part of Lab Manager's address. Pure (no React, no DOM), so node --test imports it.
//
//   ?…&srv=<server key>[&sec=…]           a server window (srv = the server's identity key, windowKey)
//   ?…&open=<kind>:<id>[&sec=…]           any other window; kind is dev | unit | cooling | rack | twin, split at the
//                                           first ":" (an id may contain ":")
//   sec = units | activity | move | delete  the part to open on (delete only previews; it never applies anything)
//
// Only one window shows at a time: srv and open never appear together (windowSearch drops the other one). The tab and
// every other parameter stay as they are, so a window opens over the current tab and a link to it can be shared.
// navigate(), selectRack() and openDetail() drop the window parameters (WINDOW_DROP_PARAMS); the twin's replaceState
// (?select=) keeps them.

export const WINDOW_KINDS = ["server", "dev", "unit", "cooling", "rack", "twin"];
export const OPEN_KINDS = WINDOW_KINDS.filter(kind => kind !== "server");
export const WINDOW_SECTIONS = ["units", "activity", "move", "delete"];
// Parameters a tab change drops (srv/open/sec: the window; item: a Racks unit; focus: a highlighted row).
export const WINDOW_DROP_PARAMS = ["srv", "open", "sec", "item", "focus"];

const MAX_ID = 300;
const cleanId = value => {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= MAX_ID ? id : null;
};
const cleanSec = value => (WINDOW_SECTIONS.includes(value) ? value : null);

// A target from its parts, or null when it is not a window.
export function windowTarget(kind, id, sec = null) {
  const cleaned = cleanId(id);
  if (!WINDOW_KINDS.includes(kind) || !cleaned) return null;
  const target = { kind, id: kind === "server" ? cleaned.toLowerCase() : cleaned };
  const section = cleanSec(sec);
  if (section) target.sec = section;
  return target;
}

// The window an address names: { kind: "server", id, sec? } | { kind: "dev"|"unit"|"cooling"|"rack"|"twin", id, sec? }
// | null. srv wins when both are present (an address written by hand).
export function parseWindow(search) {
  const params = new URLSearchParams(search || "");
  const sec = params.get("sec");
  if (params.has("srv")) return windowTarget("server", params.get("srv"), sec);
  const open = params.get("open");
  if (!open) return null;
  const at = open.indexOf(":");
  if (at <= 0) return null;
  const kind = open.slice(0, at);
  return OPEN_KINDS.includes(kind) ? windowTarget(kind, open.slice(at + 1), sec) : null;
}

// The address's search part with this window (null: no window): "?tab=…&srv=…" or "" when nothing is left.
export function windowSearch(search, target) {
  const params = new URLSearchParams(search || "");
  for (const name of ["srv", "open", "sec"]) params.delete(name);
  const clean = target ? windowTarget(target.kind, target.id, target.sec) : null;
  if (clean) {
    if (clean.kind === "server") params.set("srv", clean.id);
    else params.set("open", `${clean.kind}:${clean.id}`);
    if (clean.sec) params.set("sec", clean.sec);
  }
  // A colon needs no escaping in a query: open=dev:pdu8 stays readable in the address bar.
  const text = params.toString().replace(/%3A/gi, ":");
  return text ? `?${text}` : "";
}

// A whole href with this window (keeps the path and the hash).
export function windowHref(href, target) {
  const url = new URL(href);
  url.search = windowSearch(url.search, target);
  return url.href;
}

// The same window (kind and id; the section does not count).
export function sameWindow(a, b) {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

// "server:opt11", "dev:pdu8": a stable key for React and for the history entry a window pushed.
export const windowId = target => (target ? `${target.kind}:${target.id}` : "");

// A history entry Lab Manager wrote before windows existed (a PDU or KVM detail page): its device window.
export function legacyViewTarget(state) {
  const view = state?.view;
  return view && (view.kind === "pdu" || view.kind === "kvm") ? windowTarget("dev", String(view.id ?? "")) : null;
}

// The open window as the assistant's context detail (the kinds the assistant knows: pdu, kvm, server, item, rack);
// null for none or another kind. devices: App's device list (a dev window is a PDU or a KVM).
export function assistantDetail(target, devices = []) {
  if (!target) return null;
  if (target.kind === "server") return { kind: "server", id: target.id };
  if (target.kind === "dev") {
    const kind = (Array.isArray(devices) ? devices : []).find(d => d?.id === target.id)?.kind;
    return kind === "pdu" || kind === "kvm" ? { kind, id: target.id } : null;
  }
  if (target.kind === "unit") return { kind: "item", id: target.id };
  if (target.kind === "rack") return { kind: "rack", id: target.id };
  return null;
}

// ── Add server (v3 spec §7.1): a dialog, not a window ──
//   ?…&add=server[&rack=R][&shelf=N]   opens the add-server dialog (Operator and up) over the current tab and window.
// The provider reads it on load and on every address change, and drops add= and shelf= when the dialog closes (rack=
// stays: on Racks it is the selected rack). The twin asks with { type: "twin:open", target: { kind: "add-server", rack,
// shelf } }. parseWindow never returns this kind, so it never replaces the open window.
export const ADD_SERVER_KIND = "add-server";
export const ADD_SERVER_PARAMS = ["add", "shelf"];
const MAX_SHELF = 99;
const cleanShelf = value => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_SHELF ? n : null;
};

// { kind: "add-server", rack, shelf } (rack: a name or null; shelf: 1-99 or null), plus seat (a whole number from 1)
// and name (trimmed, at most 80 characters) when given. Always a target: every part is optional.
export function addServerTarget({ rack = null, shelf = null, seat = null, name = null } = {}) {
  const target = { kind: ADD_SERVER_KIND, rack: cleanId(rack), shelf: cleanShelf(shelf) };
  const s = cleanShelf(seat);
  if (s != null) target.seat = s;
  const n = typeof name === "string" ? name.trim() : "";
  if (n && n.length <= 80) target.name = n;
  return target;
}

// The add-server request an address names ({ kind: "add-server", rack, shelf }), or null without add=server.
export function parseAddServer(search) {
  const params = new URLSearchParams(search || "");
  if ((params.get("add") || "").trim().toLowerCase() !== "server") return null;
  const { kind, rack, shelf } = addServerTarget({ rack: params.get("rack"), shelf: params.get("shelf") });
  return { kind, rack, shelf };
}

// The address's search part with this add-server request (null: without one: add= and shelf= dropped, rack= kept).
export function addServerSearch(search, target) {
  const params = new URLSearchParams(search || "");
  for (const name of ADD_SERVER_PARAMS) params.delete(name);
  if (target) {
    const clean = addServerTarget(target);
    params.set("add", "server");
    if (clean.rack) params.set("rack", clean.rack);
    if (clean.shelf != null) params.set("shelf", String(clean.shelf));
  }
  const text = params.toString().replace(/%3A/gi, ":");
  return text ? `?${text}` : "";
}

// The twin's message asking Lab Manager to open a window (same origin and from the twin's frame only; App checks
// that): { type: "twin:open", target: { kind, id, sec?, moveTo? } }, or v1's
// { type: "twin:open-server", key, sec?, moveTo? }. Returns { target, moveTo } or null.
// An empty shelf's "Add server here" sends { type: "twin:open", target: { kind: "add-server", rack, shelf } }: the
// target is then addServerTarget's { kind: "add-server", rack, shelf } (App passes it to open(), which opens the dialog).
export const TWIN_OPEN_TYPES = ["twin:open", "twin:open-server"];
export function twinOpenRequest(data) {
  if (!data || typeof data !== "object") return null;
  let target = null;
  if (data.type === "twin:open" && data.target && typeof data.target === "object" && data.target.kind === ADD_SERVER_KIND) {
    const { kind, rack, shelf } = addServerTarget({ rack: data.target.rack, shelf: data.target.shelf });
    return { target: { kind, rack, shelf }, moveTo: null };
  }
  if (data.type === "twin:open" && data.target && typeof data.target === "object") {
    target = windowTarget(data.target.kind, data.target.id, data.target.sec);
  } else if (data.type === "twin:open-server") {
    target = windowTarget("server", data.key, data.sec);
  }
  if (!target) return null;
  const source = data.type === "twin:open" ? data.target : data;
  const moveTo = source.moveTo && typeof source.moveTo === "object" && typeof source.moveTo.rack === "string"
    && Number.isInteger(source.moveTo.u) ? { rack: source.moveTo.rack, u: source.moveTo.u } : null;
  return { target, moveTo };
}
