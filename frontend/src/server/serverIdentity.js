// The server window's identity package (one-place spec v1 WP-2): Rename, Owner & network, Units on this floor and
// Remove / Restore. Pure helpers (no React, no DOM), so node --test imports them (__tests__/server-identity.test.js);
// RenameAction.jsx, RemoveAction.jsx, sections/OwnerNetworkBlock.jsx and sections/UnitsSection.jsx use them.
import { serverName } from "../api/renameEverywhere.js";
import { validFloor, placeWord } from "../components/racks/floors.js";
import { windowKey } from "./serverKey.js";

const text = value => (value == null ? "" : String(value).trim());
const asArray = value => (Array.isArray(value) ? value : []);
const MAX_NAME = 200;   // backend devices._MAX_NAME

// ── Rename ──

// The name rename-opt renames from: the server's name without a feed suffix ("OPT53 (PSU1)" -> "OPT53"), so every
// feed keeps its own suffix ("OPT53 (PSU2)" -> "OPT53X (PSU2)").
export const renameFrom = record => serverName(record?.name || record?.key || "");

// The new name typed in the Rename dialog: { name, key } when it can be previewed, else { error }.
export function checkRename(record, value) {
  const name = text(value);
  if (!name) return { error: "Type the new name." };
  if (name.length > MAX_NAME) return { error: `A server name is at most ${MAX_NAME} characters.` };
  const key = windowKey(name);
  if (!key) return { error: `"${name}" is not a server name (a default port name or placeholder).` };
  if (key === record?.key) return { error: `${name} is the same server. Type a new name.` };
  return { name, key };
}

// A refused preview whose new name is already a server (409 "<name> already exists — …", backend _RENAME_EXISTS):
// { key, name } of that server, for "Swap with <name>"; null for any other refusal.
export function existingServer(error, newName) {
  const detail = String(error?.detail ?? error?.message ?? "");
  if (error?.status !== 409 || !/already exists/.test(detail)) return null;
  const named = /^(?:\d{3}:\s*)?(.+?) already exists/.exec(detail)?.[1]?.trim() || "";
  const key = windowKey(named) || windowKey(newName);
  return key ? { key, name: named || text(newName) } : null;
}

// The "Last change" panel after a rename: { title, lines } from the preview that was applied.
export function renameResult(preview, from, to) {
  const lines = asArray(preview?.changes).map(c => `${c.device_name || c.device_id} ${c.kind === "pdu" ? "outlet" : "port"} ${c.port}: ${text(c.before)} → ${text(c.after)}`);
  if (preview?.monitor) lines.push(`Ping monitor: ${text(preview.monitor.before)} → ${text(preview.monitor.after)}`);
  if (preview?.owner?.name) lines.push(`Owner ${text(preview.owner.name)} kept`);
  const layout = asArray(preview?.layout).filter(e => e?.before != null).length;
  if (layout) lines.push(`${layout} rack layout ${layout === 1 ? "entry" : "entries"} renamed`);
  return { title: `Renamed ${from} to ${to}.`, lines };
}

// ── Owner ──

// Writes one value under every key, in order, and stops at the first failure: { saved: [key], failed: { key, error }
// | null }. write(key) does one PUT /api/opt-owners/{key}.
export async function writeEveryKey(keys, write) {
  const saved = [];
  for (const key of keys) {
    try { await write(key); }
    catch (error) { return { saved, failed: { key, error } }; }
    saved.push(key);
  }
  return { saved, failed: null };
}

// The error a partly saved owner change shows: which keys were saved and which were not.
export function partialOwnerText(result, keys) {
  const { saved, failed } = result;
  const left = keys.slice(keys.indexOf(failed.key));
  const reason = failed.error?.message || String(failed.error || "");
  return saved.length
    ? `Saved for ${saved.join(", ")}; not saved for ${left.join(", ")}: ${reason}`
    : `Not saved: ${reason}`;
}

// "OPT53 (PSU1) → Alice, OPT53 (PSU2) → Bob": an owner (or switch) per key, each key named by its port label.
export function perKeyText(record, perKey, show = v => v) {
  const labels = new Map([...asArray(record?.pdu), ...asArray(record?.kvm)].map(p => [text(p.label).toLowerCase(), text(p.label)]));
  return Object.entries(perKey || {}).map(([key, value]) => `${labels.get(key) || key} → ${show(value)}`).join(", ");
}

// The owner(s) as one phrase: "Eden Levi", "no owner", or per key when the keys had different owners.
export function ownerSummary(record, perKey) {
  const values = [...new Set(Object.values(perKey || {}).map(text).filter(Boolean))];
  if (!values.length) return "no owner";
  return values.length === 1 && Object.keys(perKey).length >= 1 ? values[0] : perKeyText(record, perKey);
}

// Undo of an owner change: the writes that put back what each key had before ({ ok, writes: [{ key, engineer_id }] }),
// or { ok: false, why } when a previous owner is not an active engineer (PUT takes an engineer id, so a legacy name
// cannot be written back). before: { key: owner name } of the keys that had one.
export function ownerUndoPlan(keys, before, engineers) {
  const people = asArray(engineers).filter(e => e && e.active);
  const writes = [];
  for (const key of keys) {
    const name = text(before?.[key]);
    if (!name) { writes.push({ key, engineer_id: null }); continue; }
    const person = people.find(e => e.name === name);
    if (!person) return { ok: false, why: `${name} is not in the engineer list, so this change cannot be undone here.` };
    writes.push({ key, engineer_id: person.id });
  }
  return { ok: true, writes };
}

// The guard of that Undo: the keys whose owner is no longer what this window wrote (another session changed them).
// Undo reverts nothing when the list is not empty (PUT /api/opt-owners/{key} is last-write-wins).
export function ownerChangedSince(keys, written, owners) {
  return keys.filter(key => text(owners?.[key]) !== text(written));
}

// ── Switch ──

export const sameSwitch = (a, b) => text(a?.switch) === text(b?.switch) && text(a?.port) === text(b?.port);
export const switchText = value => (value && (text(value.switch) || text(value.port))
  ? `${text(value.switch) || "—"}${text(value.port) ? ` · port ${text(value.port)}` : ""}` : "None");

// The switch fields as saved: { switch, port } trimmed, or null when both are empty.
export function switchValue(draft) {
  const value = { switch: text(draft?.switch), port: text(draft?.port) };
  if (!value.switch && !value.port) return null;
  if (value.switch.length > 120 || value.port.length > 40) throw new Error("The switch name is at most 120 characters and the port at most 40.");
  return value;
}

// ── Units on this floor ──

// Where Scan barcode adds units ({ target: { rack, u, position, label } }), or { why } when the server has no floor.
export function scanTarget(record) {
  const name = record?.name || record?.key || "This server";
  const drawn = record?.drawn;
  if (!drawn) {
    if (!asArray(record?.pdu).length && asArray(record?.kvm).length) return { why: `${name} is only on a KVM port and not drawn on a rack, so it has no floor for units.` };
    return { why: `${name} is not drawn on a rack, so it has no floor for units.` };
  }
  if (!validFloor(drawn.u, drawn.rack)) {
    const where = drawn.u == null ? "has no floor number" : drawn.u === 0 ? "is on the rack level" : `is at U ${drawn.u}, above the ${placeWord(drawn.rack) === "shelf" ? "shelves" : "floors"}`;
    return { why: `${name} ${where} in ${drawn.rack}, so it has no floor for units.` };
  }
  return { target: { rack: drawn.rack, u: drawn.u, position: "", label: placeWord(drawn.rack) === "floor" ? record.name : "" } };
}

// The notes under the list: the floor is shared, the rack has cooling units or rack-level units (they never move).
export function floorNotes(record, { rackItems, chillers } = {}) {
  const notes = [];
  const drawn = record?.drawn;
  if (!drawn) return notes;
  const word = placeWord(drawn.rack);
  if (asArray(record.floorShared).length) {
    notes.push(`Shares ${word} ${drawn.u} with ${record.floorShared.join(", ")}. These units stay when one server moves.`);
  }
  const cooling = asArray(chillers?.units).some(u => u && u.rack === drawn.rack);
  const rackLevel = asArray(rackItems?.[drawn.rack]).some(item => item && !(Number(item.u) >= 1));
  if (cooling || rackLevel) notes.push("Cooling units and rack-level units never move with a server.");
  return notes;
}

// ── Removed servers: Restore ──

// The Deleted-list entry (GET /api/lab/deleted) that holds this item and is not restored yet: { batch, entry } or null.
// A server removed before the Deleted list existed has none and is restored through /api/removed-servers/restore.
export function deletedEntry(deleted, key, kind = "server") {
  for (const batch of asArray(deleted?.batches)) {
    const entry = asArray(batch?.entries).find(e => e && e.kind === kind && String(e.id) === key && !e.restored_at);
    if (entry) return { batch, entry };
  }
  return null;
}
