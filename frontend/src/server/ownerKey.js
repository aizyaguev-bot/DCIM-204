// Owner and switch of one server across its keys. Pure (no React, no DOM).
//
// A server's owner and switch port are stored per key: Racks writes them under each DCIM id (the lower-cased port
// label: "opt53 (psu1)", "opt53 (psu2)"), Inventory and the 3D twin under the identity key ("opt53"). The window reads
// every key, shows one value, and says so when the keys disagree. It writes the same value under every key, so they
// agree afterwards. Owners: PUT /api/opt-owners/{key} once per key (Operator); never the unkeyed PUT /api/opt-owners,
// which replaces the whole map and is Admin only.

const clean = value => (value == null ? "" : String(value).trim());
const unique = list => [...new Set(list.filter(k => typeof k === "string" && k !== ""))];

// The keys to read an owner from: the identity key first, then each DCIM id.
export function ownerReadKeys(record) {
  return unique([record?.key, ...(Array.isArray(record?.dcim_ids) ? record.dcim_ids : [])]);
}

// The keys an owner change writes (PUT each in this order, stop at the first failure and report which were saved).
export function ownerWriteKeys(record) {
  return ownerReadKeys(record);
}

// { value, perKey: {key: owner}, disagree }. value: the identity key's owner, else the first DCIM id's that has one,
// else "". perKey lists only keys with an owner. disagree: two keys carry different owners.
export function ownerOf(record, owners) {
  const perKey = {};
  for (const key of ownerReadKeys(record)) {
    const owner = clean(owners?.[key]);
    if (owner) perKey[key] = owner;
  }
  const values = [...new Set(Object.values(perKey))];
  const value = perKey[record?.key] || Object.values(perKey)[0] || "";
  return { value, perKey, disagree: values.length > 1 };
}

// A switch assignment as the layout file keeps it: { switch, port } (either may be missing).
const sameSwitch = (a, b) => clean(a?.switch) === clean(b?.switch) && clean(a?.port) === clean(b?.port);
const hasSwitch = value => !!(value && (clean(value.switch) || clean(value.port)));

// The keys a switch assignment is read from and written to: the DCIM ids (Racks keys switch_assignments.json by them),
// else the identity key.
function switchKeys(record) {
  const ids = unique(Array.isArray(record?.dcim_ids) ? record.dcim_ids : []);
  return ids.length ? ids : unique([record?.key]);
}

// { value: {switch, port} | null, perKey: {key: {switch, port}}, disagree }.
export function switchOf(record, assignments) {
  const perKey = {};
  for (const key of switchKeys(record)) {
    const entry = assignments?.[key];
    if (hasSwitch(entry)) perKey[key] = { switch: clean(entry.switch), port: clean(entry.port) };
  }
  const entries = Object.values(perKey);
  const value = entries[0] || null;
  return { value, perKey, disagree: entries.some(e => !sameSwitch(e, value)) };
}

// A new switch_assignments document with `value` ({switch, port}) under every DCIM id of the server; an empty value
// removes the entries. The input is not changed.
export function withSwitch(assignments, record, value) {
  const next = { ...(assignments && typeof assignments === "object" ? assignments : {}) };
  for (const key of switchKeys(record)) {
    if (hasSwitch(value)) next[key] = { switch: clean(value.switch), port: clean(value.port) };
    else delete next[key];
  }
  return next;
}
