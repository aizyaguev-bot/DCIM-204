// Pure helpers for the PDU <-> KVM mapping page (SyncView). Kept free of DOM/React so node --test can import this
// module. locations.js is only read from here (another page owns it).
import { serverIdentity } from "./locations.js";
import { deviceState, STATE_TEXT, errorMessage } from "./client.js";

const MAX_LISTED_PORTS = 256;
const isNumber = port => /^\d+$/.test(port);
const portOrder = (a, b) => (isNumber(a) && isNumber(b) ? Number(a) - Number(b) : isNumber(a) ? -1 : isNumber(b) ? 1 : a.localeCompare(b));

// Every port of a PDU/KVM as [port, label], merged per port. A port the live status lists keeps its live label: the
// server already applies the saved labels to every status it returns, and the status is polled while the device list
// is not. Ports the status does not list (all of them while the status is unavailable) come from the labels saved on
// the device (devices[].labels) over 1..port_count, so a device that cannot be read still shows its links.
function portLabels(device, livePorts) {
  const labels = new Map();
  for (const p of livePorts || []) {
    if (p?.number != null && String(p.number).trim()) labels.set(String(p.number), String(p.label ?? ""));
  }
  const live = labels.size > 0;
  if (!live) {
    for (let n = 1; n <= Math.min(Number(device?.port_count) || 0, MAX_LISTED_PORTS); n++) labels.set(String(n), "");
  }
  for (const [port, label] of Object.entries(device?.labels || {})) {
    const key = String(port).trim();
    if (typeof label !== "string" || !key) continue;
    if (!live || !labels.has(key)) labels.set(key, label);
  }
  return [...labels].sort((a, b) => portOrder(a[0], b[0]));
}

// KVM ports for the edit row's port list: [{ number: "3", label: "OPT13" }].
export const syncKvmPorts = (kvm, status) => portLabels(kvm, status?.ports).map(([number, label]) => ({ number, label }));

// label (lower case) -> { device_id, device_name, port, label } for every KVM port that holds a server name.
// A KVM whose status is unavailable still links through its saved labels.
export function syncKvmIndex(kvms, kvmStatuses) {
  const index = {};
  for (const kvm of kvms || []) {
    for (const { number, label } of syncKvmPorts(kvm, kvmStatuses?.[kvm.id])) {
      if (serverIdentity(label)) index[label.toLowerCase()] = { device_id: kvm.id, device_name: kvm.name || kvm.id, port: number, label };
    }
  }
  return index;
}

// KVMs whose status arrived without ports (failed request, unreachable, error), for the "links come from saved
// labels" banner. A KVM whose status has not arrived yet is waiting, not unavailable.
export const syncKvmUnavailable = (kvms, kvmStatuses) =>
  (kvms || []).filter(k => kvmStatuses?.[k.id] && !kvmStatuses[k.id].ports?.length && deviceState(kvmStatuses[k.id]) !== "online");

const unreachable = status => ["offline", "unavailable", "error"].includes(deviceState(status));
// A PDU status the page can show power for: online, or an error reported next to readable outlets.
const pduReadable = status => !unreachable(status) || !!(status.reachable && status.outlets?.length);

// PDUs whose status arrived but could not be read (offline, failed request, error without outlets).
export const syncPduUnavailable = (pdus, pduStatuses) =>
  (pdus || []).filter(p => pduStatuses?.[p.id] && !pduReadable(pduStatuses[p.id]));

// Table rows for one PDU. Live outlets when the status has them; for a PDU that could not be read, its saved labels
// over 1..port_count so the links stay editable. The placeholder row is left only for "not loaded yet" (pending) and
// "unreachable with nothing saved".
export function syncPduRows(pdu, status, kvmIndex = {}) {
  const base = { pdu_id: pdu.id, pdu_name: pdu.name || pdu.id };
  const row = (number, state, watts, label) => ({
    ...base, outlet_number: number, outlet_state: state, outlet_watts: watts, label,
    // A default "Outlet N" (or blank) label means no server is assigned.
    assigned: !!serverIdentity(label),
    kvm: serverIdentity(label) ? kvmIndex[label.toLowerCase()] || null : null,
    noStatus: false,
  });
  if (status?.outlets?.length) return status.outlets.map(o => row(o.number, o.state, o.watts ?? null, o.label || ""));
  const saved = status ? portLabels(pdu, []) : [];
  if (saved.length) return saved.map(([port, label]) => ({ ...row(isNumber(port) ? Number(port) : port, null, null, label), saved: true }));
  return [{ ...base, outlet_number: null, outlet_state: null, outlet_watts: null, label: "", kvm: null, noStatus: true, pending: !status }];
}

// The PDU group header: power figures for a readable PDU, otherwise its state and error.
export function syncPduSummary(status) {
  if (!status) return "? on · —";
  if (!pduReadable(status)) return [STATE_TEXT[deviceState(status)], status.error].filter(Boolean).join(" · ");
  const on = (status.outlets || []).filter(o => o.state === "on").length;
  const watts = status.reachable && status.total_watts != null
    ? `${status.total_watts.toFixed(0)}W${status.watts_complete === false ? " (partial)" : ""}` : "—";
  return `${on} on · ${watts}${status.error ? ` · ${status.error}` : ""}`;
}

const oldName = row => (row?.assigned ? row.label : "");

// True when the edit changes which KVM port this outlet's server is linked to.
export const syncKvmChanged = (row, draft) =>
  (row?.kvm?.device_id || "") !== (draft?.kvmDeviceId || "") || String(row?.kvm?.port ?? "") !== String(draft?.kvmPort ?? "");

// Linking a KVM port that holds another server's name moves that port to this server. Returns the confirm text, or
// null when the target is free ("Port 2", blank), unknown (typed by hand), this row's own port or this same server.
// `shown` is the label the page showed for the target port.
export function syncKvmConflict(row, draft, kvmName, shown) {
  const port = String(draft?.kvmPort ?? "").trim();
  if (!draft?.kvmDeviceId || !port) return null;
  if (row?.kvm && row.kvm.device_id === draft.kvmDeviceId && String(row.kvm.port) === port) return null;
  const owner = serverIdentity(shown);
  if (!owner) return null;
  const name = draft.label || oldName(row);
  if ([name, oldName(row)].some(label => serverIdentity(label) === owner)) return null;
  const used = String(shown).trim();
  return `${kvmName || draft.kvmDeviceId} port ${port} is used by ${used}.\n\nLink it to ${name} instead? ${used} will no longer be linked to this KVM port.`;
}

// The direct-label writes one save makes, in order. Each carries `expected`, the label the page showed when editing
// began (`row` is that snapshot), so a port changed in another session is refused (409) instead of overwritten.
// `shown` is the target port's label from the port list, or undefined when the port was typed by hand.
export function syncSaveWrites(row, draft, kvmName, shown) {
  const before = oldName(row), after = draft.label;
  const labelChanged = before !== after;
  const writes = [];
  const kvmWrite = (kvm, label) => ({
    device_id: kvm.device_id, port: String(kvm.port), label, expected: kvm.label ?? row.label ?? "",
    where: `${kvm.device_name || kvm.device_id} port ${kvm.port}`,
  });
  if (labelChanged) {
    writes.push({ device_id: row.pdu_id, port: String(row.outlet_number), label: after, expected: row.label ?? "",
      where: `${row.pdu_name} outlet ${row.outlet_number}` });
  }
  if (syncKvmChanged(row, draft)) {
    if (row.kvm) writes.push(kvmWrite(row.kvm, ""));
    if (draft.kvmDeviceId && draft.kvmPort) {
      writes.push({ device_id: draft.kvmDeviceId, port: String(draft.kvmPort), label: after || before, expected: shown,
        where: `${kvmName || draft.kvmDeviceId} port ${draft.kvmPort}` });
    }
  } else if (labelChanged && row.kvm) {
    writes.push(kvmWrite(row.kvm, after));
  }
  return writes;
}

// Runs the writes one at a time and stops at the first failure, so the message can name what was saved.
export async function runSyncWrites(writes, setLabel) {
  const done = [];
  for (const w of writes) {
    try { await setLabel(w.device_id, w.port, w.label, w.expected); done.push(w); }
    catch (error) { return { done, failed: { ...w, error } }; }
  }
  return { done, failed: null };
}

const listText = items => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const sentence = text => (/[.!?]$/.test(text) ? text : `${text}.`);

// "Save failed: …" when nothing was written; otherwise names what was saved and the step that failed.
export function syncSaveFailureText(done, failed) {
  const detail = errorMessage(failed.error);
  if (!done.length) return `Save failed: ${detail}`;
  const saved = listText(done.map(w => `${w.where} was ${w.label ? "updated" : "cleared"}`));
  return sentence(`${saved}, but ${failed.where} could not be updated: ${detail}`);
}
