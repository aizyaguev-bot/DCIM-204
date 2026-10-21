// PDU/KVM label editors: keep an open draft when the labels were saved in another session (409).
// Pure helpers, free of DOM/React, so node --test can import this module.
import { labelChanges, labelEditState } from "./locations.js";

const text = value => String(value ?? "").trim();

// Rebase an open draft onto the labels saved meanwhile.
// draft/original: the editor's form maps ({ port: label }); latestSaved: the device's saved labels now;
// ports: the live outlet/port list the editor was built from.
// Every port the user changed keeps the typed text; every other port shows the latest value. The new original and
// base are the latest saved state, so labelPatchBody(base, draft, original) carries their changes plus ours.
// kept: our changed ports nobody else touched. conflicts: ports also changed elsewhere to another value
// ({ port, theirs }); the draft keeps our text there too, and the caller says that Save replaces theirs.
// A port both sides changed to the same text is already saved and is neither kept nor a conflict.
export function rebaseLabelDraft(draft, original, latestSaved, ports) {
  const fresh = labelEditState(latestSaved, ports);
  const next = { ...fresh.draft };
  const nextOriginal = { ...fresh.original };
  const kept = [];
  const conflicts = [];
  for (const port of labelChanges(draft, original)) {
    const before = text(original?.[port]);
    const theirs = port in fresh.original ? text(fresh.original[port]) : before;
    const mine = text(draft[port]);
    if (theirs !== before && theirs === mine) continue;
    if (!(port in nextOriginal)) nextOriginal[port] = original?.[port] ?? "";
    next[port] = draft[port];
    if (theirs === before) kept.push(port);
    else conflicts.push({ port, theirs });
  }
  return { draft: next, original: nextOriginal, base: fresh.base, kept, conflicts };
}

const list = (noun, ports) => `${ports.length === 1 ? noun : `${noun}s`} ${ports.join(", ")}`;

// The amber note after a rebase. noun: "outlet" or "port". Never asks for a page reload.
export function rebaseNote({ kept, conflicts }, noun) {
  const parts = ["Someone else saved labels on this device while you were editing. Their changes are shown now."];
  if (kept.length) parts.push(`Your changes to ${list(noun, kept)} are kept.`);
  for (const c of conflicts) {
    const theirs = text(c.theirs);
    parts.push(`${noun[0].toUpperCase()}${noun.slice(1)} ${c.port} was also changed to ${theirs ? `"${theirs}"` : "an empty label"}; your text is kept and Save will replace it.`);
  }
  parts.push("Review the labels and click Save.");
  return parts.join(" ");
}

export const LATEST_NOT_LOADED = "Could not load the latest labels. Your changes are kept; click Save to try again.";

// The device to rebase on after a 409: the fresh copy the app attached (e.latest), else the device the app has
// reloaded meanwhile when its revision moved on. undefined: nothing newer is known yet.
export function latestDevice(error, current, revision) {
  if (error?.latest && typeof error.latest === "object") return error.latest;
  if (current?.labels_revision && current.labels_revision !== revision) return current;
  return undefined;
}
