// Shelves own the PDU outlets and KVM ports (v3 spec, C:/t/one-place-spec-v3-shelf-ports.md): which outlet or port
// belongs to which rack · shelf · seat, the add-server and wiring requests, and the texts every screen shares. Pure
// helpers plus the request helpers of /api/shelves (backend routers/shelves.py, WP-S). Free of DOM/React so node --test
// imports it. The contract is window/CONTRACT.md §11.
//
// Fail soft (spec decision 3): a missing backend route, an unavailable map and an empty map all mean "no shelf map".
// loadShelves answers { unavailable: true, …empty } on 404, the helpers answer null / [] / "" for it, and every caller
// then behaves exactly as before the shelf map existed.
//
//   loadShelves()                                       GET /api/shelves -> { revision, seeded, seed_report, racks,
//                                                       unmapped, off_shelf, problems, etag } (Viewer)
//   previewAddServer(body), addServer(body, planRevision)              POST /api/shelves/add-server (dry run / apply)
//   previewShelfPorts(changes, revision), saveShelfPorts(changes, revision, planRevision)   PUT /api/shelves/ports
//
// A refusal throws an Error whose message is the server's text, with `status`; a 409 / 422 / 403 whose detail is an
// object ({ code, text, …}) also gets `code` and `info` (the whole object). A backend without these routes answers 404:
// the error then has `unavailable: true` and says so.
import { placeWord, placesWord } from "../components/racks/floors.js";
import { isServerLabel } from "../server/serverKey.js";

export const SHELVES_PATH = "/api/shelves";
export const ADD_SERVER_PATH = `${SHELVES_PATH}/add-server`;
export const SHELF_PORTS_PATH = `${SHELVES_PATH}/ports`;
export const UNAVAILABLE_TEXT = "Shelves are not available on this Lab Manager version yet.";

const asArray = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? "" : String(value));
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
const MAX_PORTS = 96;

// A whole number from a number or decimal text ("3", 3), else null.
function toInt(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return null;
}

// A port's key as the backend writes it: decimal text without a leading zero ("03" -> "3"); other text trimmed.
export function portKey(port) {
  const raw = text(port).trim();
  return /^\d+$/.test(raw) ? String(Number(raw)) : raw;
}

// ── labels ──

// §6.1 "free": blank, a default port name, or a placeholder (empty|free|spare|n/a|-). "KVM Power" and "PDU" feed
// equipment and are never free.
const DEFAULT_PORT_LABEL = /^((outlet|port)\s*\d+)?$/i;
const PLACEHOLDER_LABEL = /^(empty|free|spare|n\/a|-+)$/i;
const INFRASTRUCTURE_LABEL = /^(kvm[\s_-]*power|pdu)$/i;
export const isFreePortLabel = label => { const t = text(label).trim(); return DEFAULT_PORT_LABEL.test(t) || PLACEHOLDER_LABEL.test(t); };
const shownLabel = label => { const t = text(label).trim(); return DEFAULT_PORT_LABEL.test(t) ? "" : t; };

// ── places ──

// A place { rack, shelf, seat, feed?, source?, places? } as the API sends it, cleaned; null when it is not one.
// seat defaults to 1. source is "shelf" or "conflict" (§4.1); places lists every seat of a conflict.
export function normalizePlace(place) {
  if (!place || typeof place !== "object") return null;
  const rack = text(place.rack).trim();
  const shelf = toInt(place.shelf);
  if (!rack || shelf == null || shelf < 1) return null;
  const seat = toInt(place.seat);
  const out = { rack, shelf, seat: seat != null && seat >= 1 ? seat : 1 };
  const feed = toInt(place.feed);
  if (feed != null) out.feed = feed;
  if (place.source === "shelf" || place.source === "conflict") out.source = place.source;
  if (Array.isArray(place.places)) {
    out.places = place.places.map(p => normalizePlace(p && typeof p === "object" ? { rack: p.rack, shelf: p.shelf, seat: p.seat } : null)).filter(Boolean);
  }
  return out;
}

const samePlace = (a, b) => !!a && !!b && a.rack === b.rack && a.shelf === b.shelf && (a.seat || 1) === (b.seat || 1);

// The seat's letter: 1 -> "A", 2 -> "B", … 26 -> "Z", 27 -> "AA". "" for anything that is not a seat.
export function seatLetter(seat) {
  let n = toInt(seat);
  if (n == null || n < 1) return "";
  let out = "";
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

// "Rack-05 · floor 3" (the rack's word, floors.js placeWord, until the WP-8 sweep says "shelf" everywhere), and
// "Rack-06 · floor 1 · B" for a second seat. seats: how many seats the shelf has; with more than one, seat 1 reads
// "· A" too. "" for no place.
export function placeText(place, { seats = null } = {}) {
  const p = normalizePlace(place);
  if (!p) return "";
  const lettered = p.seat > 1 || (toInt(seats) ?? 0) > 1;
  return `${p.rack} · ${placeWord(p.rack)} ${p.shelf}${lettered ? ` · ${seatLetter(p.seat)}` : ""}`;
}

// The short tag of a PDU / KVM tile (§8.8): "R05·S3" (the rack's last number), "Storage-Main·S3" for a rack without
// digits, "R06·S1·B" for a second seat. "" for no place.
export function shelfTag(place) {
  const p = normalizePlace(place);
  if (!p) return "";
  const digits = /(\d+)(?!.*\d)/.exec(p.rack)?.[1];
  return `${digits ? `R${digits}` : p.rack}·S${p.shelf}${p.seat > 1 ? `·${seatLetter(p.seat)}` : ""}`;
}

// The place of one PDU outlet or KVM port from GET /api/devices (device.places { "<port>": { rack, shelf, seat, feed } },
// §6.2): { rack, shelf, seat, feed } or null (not a shelf port, or an older backend without places).
export function portPlace(device, port) {
  const places = device?.places;
  if (!places || typeof places !== "object") return null;
  const key = portKey(port);
  const p = normalizePlace(Object.prototype.hasOwnProperty.call(places, key) ? places[key] : places[text(port)]);
  return p ? { rack: p.rack, shelf: p.shelf, seat: p.seat, feed: p.feed ?? null } : null;
}

// ── the /api/shelves document ──

// The document of a backend without /api/shelves (or before WP-S): no map. Callers behave as before.
export function unavailableShelves() {
  return { unavailable: true, revision: null, seeded: null, seed_report: null, racks: [], unmapped: { pdu: [], kvm: [] },
    off_shelf: [], problems: [], etag: null };
}

// A GET /api/shelves body with every list present (missing lists are empty).
export function normalizeShelves(body, etag = null) {
  const doc = body && typeof body === "object" ? body : {};
  return { ...doc, revision: doc.revision ?? null, seeded: doc.seeded ?? null, seed_report: doc.seed_report ?? null,
    racks: asArray(doc.racks), unmapped: { pdu: asArray(doc.unmapped?.pdu), kvm: asArray(doc.unmapped?.kvm) },
    off_shelf: asArray(doc.off_shelf), problems: asArray(doc.problems), etag: etag || doc.revision || null };
}

// The backend has the shelf map: GET /api/devices/locations carries shelves_revision (§3.3; WP-S always sends it, also
// for an empty map). The window provider asks GET /api/shelves only then, so an older backend never sees the request.
export const shelvesAvailable = locations => !!locations && typeof locations === "object" && Object.prototype.hasOwnProperty.call(locations, "shelves_revision");

// At least one outlet or port is assigned to a shelf. false for null, unavailable or an empty map (decision 3).
export function hasShelfMap(shelves) {
  if (!shelves || shelves.unavailable) return false;
  return asArray(shelves.racks).some(r => asArray(r?.shelves).some(s => asArray(s?.seats).some(seat => asArray(seat?.pdu).length > 0 || !!seat?.kvm)));
}

const sameRack = (a, b) => text(a) === text(b) || text(a).toLowerCase() === text(b).toLowerCase();

// The rack entry of the document (exact name first, then ignoring case), or null.
export function findRack(shelves, rack) {
  const racks = asArray(shelves?.racks);
  return racks.find(r => r?.rack === rack) || racks.find(r => sameRack(r?.rack, rack)) || null;
}

// One seat of the document: { rack, shelf, seat } (seat defaults to 1) -> the seat entry, or null.
export function findSeat(shelves, { rack, shelf, seat = 1 } = {}) {
  const entry = asArray(findRack(shelves, rack)?.shelves).find(s => toInt(s?.shelf) === toInt(shelf));
  return asArray(entry?.seats).find(s => (toInt(s?.seat) ?? 1) === (toInt(seat) ?? 1)) || null;
}

// The seat that shows this server (status "used"): { rack, shelf, seat, seats, status, mapped, kvm_only } or null.
// seats: how many seats that shelf has.
export function serverSeat(shelves, key) {
  if (!key || !shelves || shelves.unavailable) return null;
  for (const r of asArray(shelves.racks)) {
    for (const s of asArray(r?.shelves)) {
      const seats = asArray(s?.seats);
      const found = seats.find(seat => seat?.server && text(seat.server.key) === key);
      if (found) return { rack: text(r.rack), shelf: toInt(s.shelf), seat: toInt(found.seat) ?? 1, seats: Math.max(1, seats.length),
        status: text(found.status), mapped: found.mapped !== false, kvm_only: !!found.kvm_only };
    }
  }
  return null;
}

// "PDU 05 · outlet 2 · KVM 02 · port 3" for a seat's ports (§8.1, §8.2): its outlets in feed order (two on one PDU:
// "PDU 05 · outlets 3 and 4"), then its KVM port. "" when the seat has none.
export function seatPortsText(seat) {
  const groups = [];
  const feeds = asArray(seat?.pdu).slice().sort((a, b) => (toInt(a?.feed) ?? 0) - (toInt(b?.feed) ?? 0) || natural(a?.port, b?.port));
  for (const p of feeds) {
    const name = text(p?.device_name || p?.device_id);
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.ports.push(text(p.port));
    else groups.push({ name, ports: [text(p?.port)] });
  }
  const parts = groups.map(g => (g.ports.length === 1 ? `${g.name} · outlet ${g.ports[0]}`
    : `${g.name} · outlets ${g.ports.slice(0, -1).join(", ")} and ${g.ports[g.ports.length - 1]}`));
  if (seat?.kvm) parts.push(`${text(seat.kvm.device_name || seat.kvm.device_id)} · port ${text(seat.kvm.port)}`);
  return parts.join(" · ");
}

// ── conflicts (§4.1 source "conflict"; §7.11 whole-server power is off) ──

const COUNT_WORD = { 2: "two", 3: "three", 4: "four", 5: "five" };
const listText = items => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items.join(""));

// Every server whose name is on outlets of more than one seat: Map key -> { key, name, places: [place] }. Read from the
// /locations rows (place.source "conflict") and from GET /api/shelves problems ("split" with its key, or "split:<key>").
// An empty Map without either.
export function placeConflicts(locations, shelves) {
  const out = new Map();
  for (const row of asArray(locations?.servers)) {
    const place = normalizePlace(row?.place);
    if (place?.source !== "conflict" || !row?.key) continue;
    const places = place.places?.length ? place.places : [{ rack: place.rack, shelf: place.shelf, seat: place.seat }];
    out.set(text(row.key), { key: text(row.key), name: text(row.name || row.key), places });
  }
  if (shelves && !shelves.unavailable) {
    for (const p of asArray(shelves.problems)) {
      const code = text(p?.code);
      if (code !== "split" && !code.startsWith("split:")) continue;
      const key = text(p.key || code.slice(6)).trim();
      if (!key || out.has(key)) continue;
      const places = (Array.isArray(p.places) ? p.places : [p.place]).map(normalizePlace).filter(Boolean)
        .map(x => ({ rack: x.rack, shelf: x.shelf, seat: x.seat }));
      out.set(key, { key, name: text(p.name || key), places });
    }
  }
  return out;
}

// One server's conflict from a Map, a plain object or a Set of keys (a Set gives { key, places: [] }); null for none.
export function conflictOf(conflicts, key) {
  if (!conflicts || !key) return null;
  if (conflicts instanceof Map) return conflicts.get(key) || null;
  if (conflicts instanceof Set) return conflicts.has(key) ? { key, name: key, places: [] } : null;
  return typeof conflicts === "object" && Object.prototype.hasOwnProperty.call(conflicts, key) ? conflicts[key] || null : null;
}

const uniquePlaces = places => asArray(places).map(normalizePlace).filter(Boolean)
  .filter((p, i, all) => all.findIndex(q => samePlace(p, q)) === i);
const countWord = places => { const n = uniquePlaces(places).length; return n > 2 ? COUNT_WORD[n] || String(n) : "two"; };
const pluralWord = places => placesWord(uniquePlaces(places)[0]?.rack ?? null);

// §8.3 "Power disabled reason": "Its outlets are on two floors; switch single outlets from the PDU window." (the rack's
// word until the WP-8 sweep: "shelves").
export function conflictPowerReason(conflict) {
  const places = conflict?.places;
  return `Its outlets are on ${countWord(places)} ${pluralWord(places)}; switch single outlets from the PDU window.`;
}

// §8.3 conflict banner: "OPT53's name is on outlets of two floors (Rack-05 · floor 3 and Rack-05 · floor 4). Whole-server
// power is off until this is fixed: open the PDU and assign or clear the outlet." name: the server's display name.
export function conflictBannerText(name, conflict) {
  const places = uniquePlaces(conflict?.places);
  const where = places.length ? ` (${listText(places.map(p => placeText(p)))})` : "";
  return `${text(name)}'s name is on outlets of ${countWord(places)} ${pluralWord(places)}${where}. Whole-server power is off until this is fixed: open the PDU and assign or clear the outlet.`;
}

// Why a power request is refused for a conflict (§7.11): whole-server requests (scope "server") are, a single outlet
// (scope "feed") is not. null when it may be asked.
export function placePowerBlock(conflict, scope = "server") {
  return conflict && scope !== "feed" ? conflictPowerReason(conflict) : null;
}

// A power group (serverPower.js serverPowerGroup) with its conflict: { …group, placeConflict, wholeServerBlocked: reason }.
// The same group object when there is no conflict (or no group).
export function withPlaceConflict(group, conflict) {
  if (!group || !conflict) return group;
  return { ...group, placeConflict: conflict, wholeServerBlocked: conflictPowerReason(conflict) };
}

// ── Add server and Assign: the free outlets and ports a shelf can be given (§7.1, §7.10) ──

// The racks a PDU serves (§3.2): its own and every "shared:<rack>" item of its notes (split on ",", trimmed, exact).
export function pduServes(pdu, rack) {
  if (!pdu || !rack) return false;
  return pdu.rack === rack || text(pdu.notes).split(",").map(s => s.trim()).includes(`shared:${rack}`);
}

// Every port of the PDUs / KVMs that no shelf has, when the document does not list them (an older backend, or no
// document): ports 1..port_count (or the highest one known), the live label of a reachable PDU else the saved one.
function derivedUnmapped(devices, pduStatuses) {
  const out = { pdu: [], kvm: [] };
  for (const dev of asArray(devices)) {
    if (!dev || (dev.kind !== "pdu" && dev.kind !== "kvm")) continue;
    const saved = dev.labels && typeof dev.labels === "object" ? dev.labels : {};
    const status = dev.kind === "pdu" ? pduStatuses?.[dev.id] : null;
    const live = status?.reachable ? asArray(status.outlets) : [];
    const liveBy = new Map(live.map(o => [toInt(o?.number), o]));
    const numbered = [...Object.keys(saved).map(toInt), ...liveBy.keys()].filter(n => n != null && n > 0);
    const count = Math.min(Math.max(toInt(dev.port_count) || 0, ...numbered, 0), MAX_PORTS);
    for (let n = 1; n <= count; n++) {
      if (portPlace(dev, n)) continue;
      const label = text(liveBy.has(n) ? liveBy.get(n)?.label : saved[String(n)]).trim();
      out[dev.kind].push({ device_id: text(dev.id), device_name: text(dev.name || dev.id), rack: dev.rack ?? null, port: String(n), label,
        free: isFreePortLabel(label) });
    }
  }
  return out;
}

// The free, unmapped outlets and KVM ports an Admin can give a shelf, and the one to pre-select:
//   { pdu: [candidate], kvm: [candidate], suggested: { pdu: candidate | null, kvm: candidate | null } }
//   candidate = { value: "<device_id>:<port>", kind, device_id, device_name, rack, port, label, own, text }
// PDU outlets: only PDUs that serve the rack (its own, then shared:<rack> ones). KVM ports: every KVM (real KVMs serve
// several racks), the rack's own first. Read from shelves.unmapped (free only) when the document has it, else from the
// devices; a reachable PDU whose live name for the outlet names a server or "KVM Power" / "PDU" never offers it.
// suggested (§7.1, the old floorOutlet rule): the one candidate whose label is a placeholder ("Spare", "empty") and whose
// number is the shelf's; none when two match. KVM: the same among the rack's own KVMs.
export function freeShelfCandidates({ devices = [], pduStatuses = {}, shelves = null, rack = null, shelf = null } = {}) {
  const byId = new Map(asArray(devices).filter(d => d && d.id != null).map(d => [text(d.id), d]));
  const source = shelves && !shelves.unavailable && shelves.unmapped && typeof shelves.unmapped === "object"
    ? { pdu: asArray(shelves.unmapped.pdu), kvm: asArray(shelves.unmapped.kvm) }
    : derivedUnmapped(devices, pduStatuses);
  const liveLabel = (deviceId, port) => {
    const status = pduStatuses?.[deviceId];
    if (!status?.reachable) return null;
    const outlet = asArray(status.outlets).find(o => toInt(o?.number) === toInt(port));
    return outlet ? text(outlet.label).trim() : null;
  };
  const candidate = (kind, row) => {
    const device = byId.get(text(row.device_id)) || null;
    const port = portKey(row.port);
    const label = text(row.label).trim();
    const deviceName = text(row.device_name || device?.name || row.device_id);
    const deviceRack = device?.rack ?? row.rack ?? null;
    const shown = shownLabel(label);
    return { value: `${text(row.device_id)}:${port}`, kind, device_id: text(row.device_id), device_name: deviceName, rack: deviceRack, port,
      label, own: !!rack && deviceRack === rack, text: `${deviceName} · ${kind === "pdu" ? "outlet" : "port"} ${port}${shown ? ` · ${shown}` : ""}` };
  };
  const order = (a, b) => Number(b.own) - Number(a.own) || natural(a.device_name, b.device_name) || (toInt(a.port) ?? 0) - (toInt(b.port) ?? 0) || natural(a.port, b.port);

  const pdu = !rack ? [] : source.pdu
    .filter(row => row && row.free === true && portKey(row.port))
    .filter(row => { const device = byId.get(text(row.device_id)); return device ? pduServes(device, rack) : row.rack === rack; })
    .filter(row => { const live = liveLabel(text(row.device_id), row.port); return live == null || (!isServerLabel(live) && !INFRASTRUCTURE_LABEL.test(live)); })
    .map(row => candidate("pdu", row)).sort(order);
  const kvm = source.kvm
    .filter(row => row && row.free === true && portKey(row.port))
    .map(row => candidate("kvm", row)).sort(order);

  const want = toInt(shelf);
  const onlyOne = list => (list.length === 1 ? list[0] : null);
  const numbered = (list, ownOnly) => list.filter(c => (!ownOnly || c.own) && PLACEHOLDER_LABEL.test(c.label) && toInt(c.port) === want);
  return { pdu, kvm, suggested: { pdu: want ? onlyOne(numbered(pdu, false)) : null, kvm: want && rack ? onlyOne(numbered(kvm, true)) : null } };
}

// ── request bodies ──

// { device_id, port } from a candidate, a port object or "<device_id>:<port>"; null when it is not one.
function portRef(value) {
  if (typeof value === "string") {
    const at = value.lastIndexOf(":");
    return at > 0 && portKey(value.slice(at + 1)) ? { device_id: value.slice(0, at), port: portKey(value.slice(at + 1)) } : null;
  }
  if (!value || typeof value !== "object" || value.device_id == null || !portKey(value.port)) return null;
  return { device_id: text(value.device_id), port: portKey(value.port) };
}

// The add-server body (§6.1): { name, rack, shelf, seat?, owner_id?, assign?: { pdu: [port], kvm: port | null },
// reuse_deleted? }. Accepts ownerId / reuseDeleted too, and candidates or "<device_id>:<port>" values in assign.
export function addServerBody({ name = "", rack = "", shelf = null, seat = null, owner_id = undefined, ownerId = undefined, assign = null,
  reuse_deleted = false, reuseDeleted = false } = {}) {
  const body = { name: text(name).trim(), rack: text(rack).trim(), shelf: toInt(shelf) };
  const s = toInt(seat);
  if (s != null && s >= 1) body.seat = s;
  const owner = owner_id !== undefined ? owner_id : ownerId;
  if (owner != null && owner !== "") body.owner_id = owner;
  if (assign && typeof assign === "object") body.assign = { pdu: asArray(assign.pdu).map(portRef).filter(Boolean), kvm: portRef(assign.kvm) };
  if (reuse_deleted || reuseDeleted) body.reuse_deleted = true;
  return body;
}

// The changes of PUT /api/shelves/ports (§6.1): [{ device_id, port, place: { rack, shelf, seat, feed? } | null }].
// place null unassigns the port; feed only when given (the backend numbers PDU feeds itself; a KVM port has none).
export function shelfPortChanges(changes) {
  return asArray(changes).map(c => {
    const ref = portRef(c);
    if (!ref) return null;
    const p = normalizePlace(c.place);
    const place = p ? { rack: p.rack, shelf: p.shelf, seat: p.seat, ...(p.feed != null ? { feed: p.feed } : {}) } : null;
    return { ...ref, place };
  }).filter(Boolean);
}

// ── requests ──

// The Error of a refused request (see the header).
export function shelfError(status, body) {
  const detail = body && typeof body === "object" ? body.detail : undefined;
  let message = "";
  let info = null;
  if (typeof detail === "string") message = detail;
  else if (Array.isArray(detail)) message = detail.map(d => d?.msg).filter(Boolean).join("; ");
  else if (detail && typeof detail === "object") { info = detail; message = text(detail.text || detail.message || detail.detail); }
  const unavailable = status === 404 && !info && (!message || /^not found$/i.test(message.trim()));
  const error = new Error(unavailable ? UNAVAILABLE_TEXT : message || `Request failed (HTTP ${status})`);
  error.status = status;
  if (unavailable) error.unavailable = true;
  else if (message) error.detail = message;
  if (info) { error.info = info; if (info.code != null) error.code = text(info.code); }
  return error;
}

async function call(method, path, body) {
  const response = await fetch(path, {
    method, cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw shelfError(response.status, data);
  return { data, etag: response.headers?.get?.("ETag") || null };
}

// GET /api/shelves (Viewer; never contacts a device). 404 (no such route yet) or a page that is not JSON (an older
// server's index.html): unavailableShelves(). Other failures throw.
export async function loadShelves() {
  const response = await fetch(SHELVES_PATH, { cache: "no-store" });
  if (response.status === 404) return unavailableShelves();
  const type = response.headers?.get?.("content-type") || "";
  if (response.ok && type && !type.includes("json")) return unavailableShelves();
  const data = await response.json().catch(() => null);
  if (!response.ok) throw shelfError(response.status, data);
  if (!data || typeof data !== "object") return unavailableShelves();
  return normalizeShelves(data, response.headers?.get?.("ETag") || null);
}

// The add-server dry run: { plan_revision, place, ports, assigned, monitor, owner, warnings }; it writes nothing.
export async function previewAddServer(body) {
  return (await call("POST", ADD_SERVER_PATH, { ...addServerBody(body), dry_run: true })).data;
}

// The previewed add (planRevision from previewAddServer): { key, name, place, ports, names }.
export async function addServer(body, planRevision) {
  return (await call("POST", ADD_SERVER_PATH, { ...addServerBody(body), dry_run: false, ...(planRevision ? { plan_revision: planRevision } : {}) })).data;
}

// The wiring dry run (Admin): { plan_revision, changes, servers_moving, warnings }; it writes nothing. revision: the
// shelves revision the dialog was built from.
export async function previewShelfPorts(changes, revision) {
  return (await call("PUT", SHELF_PORTS_PATH, { revision: revision ?? null, dry_run: true, changes: shelfPortChanges(changes) })).data;
}

// The previewed wiring change: { revision, changes }.
export async function saveShelfPorts(changes, revision, planRevision) {
  return (await call("PUT", SHELF_PORTS_PATH, { revision: revision ?? null, dry_run: false, ...(planRevision ? { plan_revision: planRevision } : {}),
    changes: shelfPortChanges(changes) })).data;
}
