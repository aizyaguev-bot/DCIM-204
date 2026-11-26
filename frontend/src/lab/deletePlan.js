// The one delete dialog's rules (v2 spec §D.2), pure so node --test can import them (lab/DeleteDialog.jsx renders them).
//
//   targetKey(t)                     "kind:id"
//   optionsFor(targets, plan, can)   the options that apply to these targets, with their labels and values
//   defaultOptions(targets, given)   the checkbox defaults (spec table), with the caller's overrides
//   groupPlan(plan)                  { items, also: [{ key, title, rows: [text] }], blockers: [text], screens: [text] }
//   initialSelection(items)          the keys ticked at first: everything, except rows with evidence in a bulk preview
//   confirmRule(items)               how Delete is confirmed: { mode: "button" | "name" | "count", expected, label, prompt }
//   confirmed(rule, typed)           true when the typed text matches
//   applyOrRepreview(api, request)   apply; a 409 for a changed plan runs the preview again (options kept)
//   undoText(result)                 the toast after a delete: "Deleted N items"
//   restoredText(plan)               the toast after Undo: "Restored N items" (and which servers stay removed)
export const MAX_REASON = 300;

export const targetKey = t => `${t?.kind}:${t?.id}`;

const asArray = value => (Array.isArray(value) ? value : []);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// "Also changes" in the order the dialog shows them (backend lab_trash.CONSEQUENCES).
export const GROUPS = [
  ["devices_deleted", "PDUs and KVMs deleted with it"],
  ["servers_deleted", "Servers deleted with it"],
  ["servers_kept", "Servers kept"],
  ["servers_lose_port", "Servers that lose a feed or their KVM port"],
  ["ports_freed", "Outlets and ports freed (default names)"],
  ["units_moved", "Units moved to Storage-Main"],
  ["units_deleted", "Units deleted"],
  ["cooling_unassigned", "Cooling units taken off the rack"],
  ["monitors_paused", "Ping monitors paused"],
  ["alerts_closed", "Alerts closed"],
  ["twin_deleted", "3D records deleted"],
  ["twin_unplaced", "3D records unplaced"],
  ["setups_unmapped", "3D frames unmapped"],
  ["layout", "Layout, switch and owner entries cleaned"],
  ["owners", "Owners cleaned"],
  ["shared_kept", "Shared PDUs that stay"],
  ["notes", "Also"],
];

// The kinds each option applies to (spec §D.2 table) and its default.
const OPTION_KINDS = {
  orphan_servers: ["device", "rack"],
  twin_records: ["server", "device", "rack", "unit", "cooling"],
  keep_labels: ["server"],
  floor_units: ["server"],
  rack_units: ["rack"],
  twin_frame: ["rack"],
  twin_contents: ["twin"],
  unit_server: ["unit"],
};
export const DEFAULTS = { orphan_servers: true, twin_records: true, keep_labels: false, floor_units: false,
  rack_units: "storage", twin_frame: true, twin_contents: true, unit_server: true };

export function defaultOptions(targets, given = null) {
  const kinds = new Set(asArray(targets).map(t => t?.kind));
  const out = {};
  for (const [name, applies] of Object.entries(OPTION_KINDS)) {
    if (applies.some(k => kinds.has(k))) out[name] = given && name in given ? given[name] : DEFAULTS[name];
  }
  return out;
}

const rows = (plan, group) => asArray(plan?.consequences?.[group]);

// [{ name, type: "checkbox" | "radio", label, value, choices? }] for the targets; labels carry the counts the preview
// gives. unit_server is shown to Admins only (Operators see the preview's note instead).
export function optionsFor(targets, plan, can = { admin: false }, values = defaultOptions(targets)) {
  const kinds = new Set(asArray(targets).map(t => t?.kind));
  const has = name => OPTION_KINDS[name].some(k => kinds.has(k)) && name in values;
  const out = [];
  if (has("orphan_servers")) {
    const n = rows(plan, "servers_deleted").length;
    out.push({ name: "orphan_servers", type: "checkbox", value: !!values.orphan_servers,
      label: `Delete the ${n && values.orphan_servers ? `${n} ` : ""}${n === 1 && values.orphan_servers ? "server that is" : "servers that are"} only on these devices (servers that still answer are kept)` });
  }
  if (has("twin_records")) {
    const n = rows(plan, "twin_deleted").length;
    out.push({ name: "twin_records", type: "checkbox", value: !!values.twin_records,
      label: `Delete their 3D records${values.twin_records ? ` (${n})` : ""}` });
  }
  if (has("keep_labels")) out.push({ name: "keep_labels", type: "checkbox", value: !!values.keep_labels,
    label: "Keep the server's name on its outlets and KVM port" });
  if (has("floor_units")) {
    const note = rows(plan, "notes").find(r => String(r.key).startsWith("floor:"));
    const n = note?.count ?? (values.floor_units ? rows(plan, "units_deleted").length : 0);
    if (n || values.floor_units) out.push({ name: "floor_units", type: "checkbox", value: !!values.floor_units,
      label: `Also delete the ${plural(n, "unit")} on its floor` });
  }
  if (has("rack_units")) out.push({ name: "rack_units", type: "radio", value: values.rack_units === "delete" ? "delete" : "storage",
    label: "Units on the rack", choices: [["storage", "Move to Storage-Main"], ["delete", "Delete them"]] });
  if (has("twin_frame")) {
    const frame = [...rows(plan, "twin_deleted"), ...rows(plan, "setups_unmapped")].map(r => String(r.key)).find(k => /^SETUP/i.test(k));
    out.push({ name: "twin_frame", type: "checkbox", value: !!values.twin_frame, label: `Also delete its 3D frame${frame ? ` (${frame})` : ""}` });
  }
  if (has("twin_contents")) {
    const items = rows(plan, values.twin_contents ? "twin_deleted" : "twin_unplaced").length - (values.twin_contents ? asArray(targets).length : 0);
    out.push({ name: "twin_contents", type: "checkbox", value: !!values.twin_contents,
      label: `Delete the ${items > 0 ? `${items} ` : ""}3D items on it (otherwise they become unplaced)` });
  }
  if (has("unit_server") && can?.admin) {
    const server = rows(plan, "servers_deleted").find(r => /only pinged/.test(r.text || ""));
    if (server || !values.unit_server) out.push({ name: "unit_server", type: "checkbox", value: !!values.unit_server,
      label: `Also remove server ${server?.name || "of this unit"} (it is only pinged)` });
  }
  return out;
}

export function groupPlan(plan) {
  return {
    items: asArray(plan?.items),
    also: GROUPS.map(([key, title]) => ({ key, title, rows: rows(plan, key).map(r => r.text || r.title || r.name || r.key).filter(Boolean) }))
      .filter(g => g.rows.length),
    blockers: asArray(plan?.blockers).map(b => b.text).filter(Boolean),
    screens: asArray(plan?.screens),
  };
}

export const hasEvidence = item => asArray(item?.evidence).length > 0;

// Bulk previews start with the rows that show signs of life unticked; a single item is always the one deleted.
export function initialSelection(items) {
  const list = asArray(items);
  return new Set(list.filter(item => list.length === 1 || !hasEvidence(item)).map(targetKey));
}

// One item without evidence: a red button naming it. One item with evidence: type its name. Two or more: type the count.
export function confirmRule(items) {
  const list = asArray(items);
  if (list.length === 1) {
    const name = String(list[0].name || list[0].id);
    if (!hasEvidence(list[0])) return { mode: "button", expected: "", label: `Delete ${name}`, prompt: "" };
    return { mode: "name", expected: name, label: `Delete ${name}`, prompt: `Type ${name} to delete it` };
  }
  const n = String(list.length);
  return { mode: "count", expected: n, label: `Delete ${list.length} items`, prompt: `Type ${n} to delete ${list.length} items` };
}

export function confirmed(rule, typed) {
  if (!rule) return false;
  if (rule.mode === "button") return true;
  return String(typed ?? "").trim().toLowerCase() === rule.expected.trim().toLowerCase();
}

// The apply step. A 409 that is not a blocker means the lab changed since the preview: preview again with the same
// targets and options and say so; nothing was deleted. api: { applyDelete, previewDelete }.
export async function applyOrRepreview(api, { targets, options, plan, reason }) {
  try {
    return { result: await api.applyDelete(targets, options, plan.plan_revision, reason) };
  } catch (error) {
    if (error?.status !== 409 && error?.status !== 428) return { error: error?.message || String(error) };
    try {
      const fresh = await api.previewDelete(targets, options);
      return { plan: fresh, error: `${error.message || "The lab changed since the preview."} The preview below is up to date now; check it and confirm again.` };
    } catch (again) {
      return { error: again?.message || String(again) };
    }
  }
}

export function undoText(result) {
  const entries = asArray(result?.batch?.entries);
  return entries.length === 1 ? `Deleted ${entries[0].name || entries[0].id}` : `Deleted ${plural(entries.length, "item")}`;
}

// The toast after Undo (plan: the restore's answer). A server that was removed from the lab before the delete comes back
// as it was, still removed (it is not in servers_restored): the toast says so, so nobody looks for it on the racks.
export function restoredText(plan) {
  const items = asArray(plan?.items);
  const back = new Set(rows(plan, "servers_restored").map(r => r.key));
  const removed = items.filter(i => i?.kind === "server" && !back.has(i.id)).map(i => i.name || i.id);
  const head = items.length === 1 ? `Restored ${items[0].name || items[0].id}` : `Restored ${plural(items.length, "item")}`;
  if (!removed.length) return head;
  if (items.length === 1) return `${head}; it stays removed from the lab, as before`;
  return `${head}; ${removed.join(", ")} ${removed.length === 1 ? "stays" : "stay"} removed from the lab, as before`;
}
