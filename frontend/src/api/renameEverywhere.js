// "Rename everywhere": when a port label edit renames a server to a NEW name, the page previews
// POST /api/devices/rename-opt (dry_run) and asks whether the server's other PDU feeds, KVM port, rack position, ping
// monitor and owner follow. Pure helpers, free of DOM/React, so node --test can import this module.
import { serverIdentity, labelChanges, labelPatchBody } from "./locations.js";

const text = value => String(value ?? "").trim();

// "OPTN45 (PSU1)" -> "OPTN45"; any other label as written.
export function serverName(label) {
  const name = text(label);
  const match = /^(optn?\d+)\s*\([^)]*\)$/i.exec(name);
  return match ? match[1] : name;
}

// Every server identity shown on a PDU/KVM port: saved labels of `devices`, plus any other labels (live readings).
export function knownIdentities(devices, ...labelLists) {
  const known = new Set();
  const add = label => { const id = serverIdentity(label); if (id) known.add(id); };
  for (const d of devices || []) {
    if (d?.kind !== "pdu" && d?.kind !== "kvm") continue;
    for (const label of Object.values(d.labels || {})) add(label);
  }
  for (const list of labelLists) for (const label of list || []) add(label);
  return known;
}

// The renames one save makes: ports whose old label is a server and whose new label names a server that does not
// exist yet. Grouped by the old server; an old server given two different new names is left as single-port edits.
// changes: [{ port, before, after }]. Returns [{ old_name, new_name, ports }].
export function renameCandidates(changes, known) {
  const groups = new Map();
  for (const c of changes || []) {
    const oldId = serverIdentity(c.before), newId = serverIdentity(c.after);
    if (!oldId || !newId || oldId === newId || known?.has(newId)) continue;
    const group = groups.get(oldId);
    if (!group) groups.set(oldId, { newIds: new Set([newId]), old_name: text(c.before), new_name: text(c.after), ports: [String(c.port)] });
    else { group.newIds.add(newId); group.ports.push(String(c.port)); }
  }
  return [...groups.values()].filter(g => g.newIds.size === 1)
    .map(({ old_name, new_name, ports }) => ({ old_name, new_name, ports }));
}

// The label editor's changes in renameCandidates' shape.
export const editorChanges = (draft, original) =>
  labelChanges(draft, original).map(port => ({ port, before: original?.[port], after: draft?.[port] }));

// A refused preview that means "not a rename": the new name is already a server, or a label is a default port name.
// Those saves go ahead as single-port edits without asking.
export function previewSkipReason(e) {
  const detail = String(e?.detail ?? "");
  if (e?.status === 409 && /already exists/.test(detail)) return "exists";
  if (e?.status === 400 && /is not a server name/.test(detail)) return "not-server";
  return null;
}

// Asks about each rename before anything is written. preview(group) resolves to the dry-run plan; ask({ group,
// preview, error }) resolves to "everywhere", "only" or null (Cancel / Escape). Returns null when cancelled (nothing
// may be written), else the renames to apply: [{ group, preview }].
export async function chooseRenames(groups, preview, ask) {
  const chosen = [];
  for (const group of groups || []) {
    let plan = null, error = null;
    try { plan = await preview(group); } catch (e) {
      if (previewSkipReason(e)) continue;
      error = e;
    }
    const choice = await ask({ group, preview: plan, error });
    if (!choice) return null;
    if (choice === "everywhere" && plan) chosen.push({ group, preview: plan });
  }
  return chosen;
}

// The editor state once a rename is saved: this device's renamed ports hold their new labels, so the PATCH that
// follows sends only the user's other edits.
export function afterRename(deviceId, preview, base, original) {
  const nextBase = { ...(base || {}) }, nextOriginal = { ...(original || {}) };
  for (const c of preview?.changes || []) {
    if (c.device_id !== deviceId) continue;
    nextBase[c.port] = c.after;
    nextOriginal[c.port] = c.after;
  }
  return { base: nextBase, original: nextOriginal };
}

// Applies the chosen renames (each with its preview's plan_revision), then saves the rest of the editor with the
// device's new labels revision. `state` ({ base, original, revision }) is updated as each step is saved, so a caller
// that catches a later failure rebases from what is really saved. The PATCH also runs with nothing left to save: it
// reloads the page's devices and statuses. Returns { saved, renamed, remaining }.
export async function saveWithRenames(deviceId, draft, state, chosen, rename, save) {
  let renamed = null;
  for (const { group, preview } of chosen || []) {
    try {
      renamed = await rename(group.old_name, group.new_name, { planRevision: preview.plan_revision });
    } catch (e) {
      if (e && typeof e === "object") e.step = "rename";   // not a labels conflict: the caller shows it as is
      throw e;
    }
    Object.assign(state, afterRename(deviceId, preview, state.base, state.original));
    const revision = renamed?.labels_revisions?.[deviceId];
    if (revision) state.revision = revision;
  }
  const remaining = labelChanges(draft, state.original).length;
  const saved = await save(labelPatchBody(state.base, draft, state.original), state.revision);
  return { saved, renamed, remaining };
}

const kindWord = kind => (kind === "kvm" ? "port" : kind === "pdu" ? "outlet" : "port");

// What the dialog lists, from the dry-run plan.
export function describeRename(preview) {
  const changes = preview?.changes || [];
  const line = c => ({ key: `${c.device_id}:${c.port}`, where: `${c.device_name || c.device_id} ${kindWord(c.kind)} ${c.port}`,
    before: text(c.before), after: text(c.after) });
  const position = preview?.position;
  return {
    pdu: changes.filter(c => c.kind === "pdu").map(line),
    kvm: changes.filter(c => c.kind !== "pdu").map(line),
    position: position?.rack ? `${position.rack}${position.slot != null ? `, U${position.slot}` : ""}` : null,
    layoutCount: (preview?.layout || []).filter(e => e?.before != null).length,   // layout ids renamed
    pinCount: (preview?.layout || []).filter(e => e?.before == null).length,      // automatic U numbers saved as they are
    monitor: preview?.monitor ? { before: text(preview.monitor.before), after: text(preview.monitor.after) } : null,
    owner: preview?.owner ? text(preview.owner.name) : null,
  };
}
