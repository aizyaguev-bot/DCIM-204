// "Show in 3D": the references Lab Manager hands to the embedded 3D twin (lab-twin/app.js), and the twin's URL.
// The shared interface: ref = srv:<optKey> | item:<rack item id> | rack:<rack name>; the twin opens on it from
// /twin/index.html?embed=1&select=<encoded ref>, or, once loaded, from postMessage({ type: "twin:select", ref }).
export const TWIN_PATH = "/twin/index.html";
export const TWIN_SELECT_MESSAGE = "twin:select";
// How long the twin stays loaded, hidden, after leaving the Twin tab (a quick round trip or "Show in 3D" then needs no
// reload). The hidden twin keeps rendering and polling on Lab Manager's main thread, so it is removed after this.
export const TWIN_HIDDEN_KEEP_MS = 20000;

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
