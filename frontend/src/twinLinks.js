// "Show in 3D": the references Lab Manager hands to the embedded 3D twin (lab-twin/app.js), and the twin's URL.
// The shared interface: ref = srv:<optKey> | item:<rack item id> | rack:<rack name>; the twin opens on it from
// /twin/index.html?embed=1&select=<encoded ref>, or, once loaded, from postMessage({ type: "twin:select", ref }).
// The twin answers every selection the user makes in it with postMessage({ type: "twin:selected", ref | null }) to this
// page (same origin): Lab Manager puts it in its address (?select=, twinSelectedAddress). Change events go to the twin as
// postMessage({ type: "twin:data-changed", domains }).
export const TWIN_PATH = "/twin/index.html";
export const TWIN_SELECT_MESSAGE = "twin:select";
export const TWIN_SELECTED_MESSAGE = "twin:selected";
export const TWIN_DATA_CHANGED_MESSAGE = "twin:data-changed";
// How long the twin stays loaded, hidden, after leaving the Twin tab (a round trip or "Show in 3D" then needs no
// reload). A hidden twin pauses itself (no rendering, no polling: lab-twin/app.js pauseTwin), so it may stay 10 minutes;
// then it is removed (its memory: the WebGL scene) and the next visit loads it again.
export const TWIN_HIDDEN_KEEP_MS = 10 * 60 * 1000;

// A server's identity key exactly as the twin computes it (lab-twin/app.js optKey): its label trimmed and lower-cased.
export const optKey = s => (s || "").trim().toLowerCase();

export function serverRef(name) {
  const key = typeof name === "string" ? optKey(name) : "";
  return key ? `srv:${key}` : null;
}
export function itemRef(id) {
  return id != null && String(id) !== "" ? `item:${id}` : null;
}
export function rackRef(rack) {
  return typeof rack === "string" && rack.trim() ? `rack:${rack}` : null;
}

// A ref Lab Manager may pass on (a ?select= from the address bar included): one of the three kinds with a value.
export function isTwinRef(ref) {
  return typeof ref === "string" && /^(srv|item|rack):\S/.test(ref);
}

// The twin iframe's address: no (valid) ref keeps the plain embed URL.
export function twinSrc(ref) {
  return isTwinRef(ref) ? `${TWIN_PATH}?embed=1&select=${encodeURIComponent(ref)}` : `${TWIN_PATH}?embed=1`;
}

// The ref of a Lab Manager address opened on the twin (?tab=twin&select=<ref>), or null.
export function linkedTwinRef(search) {
  const params = new URLSearchParams(search);
  const ref = params.get("tab") === "twin" ? params.get("select") : null;
  return isTwinRef(ref) ? ref : null;
}

// Back / Forward onto a Twin tab address: its ?select= ref when the twin was last given another one (shown again so the
// twin follows the address), else null (no ref there, or the twin already has it).
export function twinRefToReplay(search, lastRef) {
  const ref = linkedTwinRef(search);
  return ref && ref !== lastRef ? ref : null;
}

export function twinSelectMessage(ref) {
  return { type: TWIN_SELECT_MESSAGE, ref };
}

// Lab Manager's address after the twin reported a selection (twin:selected): the Twin tab's address with ?select=<ref>
// (none for null or an invalid ref), or null when the address stays as it is (another tab, or the same ref already).
export function twinSelectedAddress(href, ref) {
  const url = new URL(href);
  if (url.searchParams.get("tab") !== "twin") return null;
  const next = isTwinRef(ref) ? ref : null;
  if ((url.searchParams.get("select") || null) === next) return null;
  if (next) url.searchParams.set("select", next);
  else url.searchParams.delete("select");
  return url.href;
}
