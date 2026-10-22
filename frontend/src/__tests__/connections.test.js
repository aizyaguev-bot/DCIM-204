import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api } from "../api/client.js";

// Run the view's exported pure helpers without a JSX loader or browser globals.
const source = readFileSync(new URL("../pages/ConnectionsView.jsx", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("export function connectionRacks"), source.indexOf("\nfunction ConnectionList"));
const { connectionRacks, filterConnections } = await import(`data:text/javascript;base64,${Buffer.from(helpers).toString("base64")}`);
const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const navigationSource = appSource.slice(appSource.indexOf("  function navigate("), appSource.indexOf("  function openDetail("));
const popSource = appSource.slice(appSource.indexOf("    const onPop ="), appSource.indexOf('    window.addEventListener("popstate"'));

function navigationHarness(adminSection = "devices") {
  const state = { adminSection, mainTab: "dashboard" };
  const window = { location: { href: "https://example.test/?tab=dashboard", search: "?tab=dashboard" } };
  const history = {
    state: null,
    pushState(value, title, url) { this.state = value; window.location.href = String(url); window.location.search = new URL(url).search; },
    replaceState(value) { this.state = value; },
  };
  const setters = ["view", "mainTab", "editMode", "adminSection", "openRack"].map(key => value => { state[key] = value; });
  const mainTabRef = { get current() { return state.mainTab; } };
  const actions = () => new Function("window", "history", "setView", "setMainTab", "setEditMode", "setAdminSection", "setOpenRack", "adminSection", `${navigationSource}; return { navigate, navigateAdmin };`)(window, history, ...setters, state.adminSection);
  const pop = new Function("location", "setView", "setMainTab", "setEditMode", "setAdminSection", "setOpenRack", "mainTabRef", `${popSource}; return onPop;`)(window.location, ...setters, mainTabRef);
  return { state, window, history, actions, pop };
}

const servers = [
  { key: "opt2", name: "OPT2", server_ip: "192.0.2.2", rack: "Rack-2", owner: "Ada", ping_status: "up",
    pdu: [{ device_id: "pdu-a", device_name: "PDU-A", device_ip: "192.0.2.20", rack: "Rack-2", port: 13, label: "OPT2 PSU-A", state: "on" },
      { device_id: "pdu-b", device_name: "PDU-B", device_ip: "192.0.2.21", rack: "Rack-10", port: 4, label: "OPT2 PSU-B", state: "off" }],
    kvm: [{ device_id: "kvm-a", device_name: "Console-A", device_ip: "192.0.2.30", port: 12, label: "OPT2 console" }] },
  { key: "opt10", name: "OPT10", server_ip: "192.0.2.10", rack: "Rack-1", owner: "Grace", ping_status: "down",
    pdu: [{ device_id: "pdu-c", device_name: "PDU-C", device_ip: "192.0.2.22", rack: "Rack-1", port: 8, label: "OPT10", state: "unknown" }], kvm: [] },
  { key: "opt20", name: "OPT20", server_ip: null, rack: null, owner: null, ping_status: "unknown",
    pdu: [], kvm: [{ device_id: "kvm-b", device_name: "Console-B", device_ip: "192.0.2.31", port: 2, label: "OPT20" }] },
  { key: "unmapped", name: "Unmapped" },
];
const keys = rows => rows.map(row => row.key);
const realFetch = globalThis.fetch;

function stubFetch(t, response) {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return response; };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

test("search covers server identity, addresses, owners and connection details", () => {
  for (const search of ["OPT2 PSU-A", "192.0.2.20", "192.0.2.30", "Console-A", "#13", "#12", "pdu-a", "Ada", "192.0.2.2", "up"]) {
    assert.ok(keys(filterConnections(servers, { search })).includes("opt2"), `search ${search}`);
  }
  assert.deepEqual(keys(filterConnections(servers, { search: "PSU-B" })), ["opt2"]);
  assert.deepEqual(keys(filterConnections(servers, { search: "192.0.2.31" })), ["opt20"]);
});

test("search ignores case and surrounding whitespace and handles missing fields", () => {
  assert.deepEqual(keys(filterConnections(servers, { search: "  gRaCe  " })), ["opt10"]);
  assert.deepEqual(keys(filterConnections(servers, { search: "unmapped" })), ["unmapped"]);
  assert.deepEqual(filterConnections(servers, { search: "no match" }), []);
  assert.equal(filterConnections(servers, { search: "  " }).length, servers.length);
});

test("rack options deduplicate server and PDU racks and sort naturally", () => {
  assert.deepEqual(connectionRacks(servers), ["Rack-1", "Rack-2", "Rack-10"]);
  assert.deepEqual(connectionRacks(), []);
});

test("rack filtering matches both server location and an attached PDU", () => {
  assert.deepEqual(keys(filterConnections(servers, { rack: "Rack-1" })), ["opt10"]);
  assert.deepEqual(keys(filterConnections(servers, { rack: "Rack-10" })), ["opt2"]);
  assert.deepEqual(filterConnections(servers, { rack: "Rack-99" }), []);
});

test("missing KVM and PDU filters include servers with no saved links", () => {
  assert.deepEqual(keys(filterConnections(servers, { connection: "missing-kvm" })), ["opt10", "unmapped"]);
  assert.deepEqual(keys(filterConnections(servers, { connection: "missing-pdu" })), ["opt20", "unmapped"]);
});

test("single feed means exactly one PDU outlet, excluding dual and zero feeds", () => {
  assert.deepEqual(keys(filterConnections(servers, { connection: "single-feed" })), ["opt10"]);
});

test("search, rack and connection filters are applied together", () => {
  assert.deepEqual(keys(filterConnections(servers, { search: "Grace", rack: "Rack-1", connection: "missing-kvm" })), ["opt10"]);
  assert.deepEqual(filterConnections(servers, { search: "Grace", rack: "Rack-2", connection: "missing-kvm" }), []);
  assert.deepEqual(filterConnections(), []);
});

test("filtering preserves backend natural order and does not alter source rows", () => {
  const before = structuredClone(servers);
  assert.deepEqual(keys(filterConnections(servers)), ["opt2", "opt10", "opt20", "unmapped"]);
  assert.equal(filterConnections(servers)[0], servers[0]);
  connectionRacks(servers);
  assert.deepEqual(servers, before);
});

test("Connections navigation uses its shareable query and restores the Admin subtab", () => {
  const app = navigationHarness();
  app.actions().navigateAdmin("connections");
  assert.equal(new URL(app.window.location.href).searchParams.get("tab"), "connections");
  assert.equal(app.state.mainTab, "admin");
  assert.equal(app.state.adminSection, "connections");
  app.state.adminSection = "devices";
  app.pop({ state: app.history.state });
  assert.equal(app.state.adminSection, "connections");
  app.pop({ state: null });
  assert.equal(app.state.adminSection, "connections");
  assert.equal(app.state.mainTab, "admin");
});

test("Back from mapping restores Connections after Dashboard and Admin navigation", () => {
  const app = navigationHarness("connections");
  app.actions().navigate("dashboard");
  app.actions().navigate("admin");
  const adminEntry = app.history.state;
  assert.equal(app.state.adminSection, "connections");
  assert.equal(adminEntry.adminSection, "connections");
  app.actions().navigateAdmin("mapping");
  assert.equal(app.state.adminSection, "mapping");
  assert.equal(app.history.state.adminSection, "mapping");
  app.pop({ state: adminEntry });
  assert.equal(app.state.mainTab, "admin");
  assert.equal(app.state.adminSection, "connections");
});

test("Manage users records Users so Back from Connections restores the users page", () => {
  const app = navigationHarness("connections");
  const callback = appSource.match(/onUsers=\{\(\) => ([^}]+)\}/)?.[1];
  assert.ok(callback, "Header exposes its Manage users callback");
  new Function("navigateAdmin", callback)(app.actions().navigateAdmin);
  const usersEntry = app.history.state;
  assert.equal(app.state.adminSection, "users");
  assert.equal(usersEntry.adminSection, "users");
  app.actions().navigateAdmin("connections");
  app.pop({ state: usersEntry });
  assert.equal(app.state.adminSection, "users");
  assert.equal(app.state.mainTab, "admin");
});

test("the summary helper uses the read-only connections endpoint", async t => {
  const payload = { servers, generated_at: "2026-10-20T10:00:00Z" };
  const calls = stubFetch(t, new Response(JSON.stringify(payload), { status: 200 }));
  assert.deepEqual(await api.getConnections(), payload);
  assert.equal(calls[0].url, "/api/devices/connections");
  assert.equal(calls[0].options.method, "GET");
});

test("the summary helper preserves the Viewer denial for the access message", async t => {
  stubFetch(t, new Response(JSON.stringify({ detail: "Operator role needed" }), { status: 403 }));
  await assert.rejects(api.getConnections(), error => error.status === 403 && error.detail === "Operator role needed");
});

test("CSV download keeps the response bytes and dated attachment filename", async t => {
  const calls = stubFetch(t, new Response("\ufeffServer,Server IP\r\nOPT2,192.0.2.2\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename=lab-connections-2026-10-20.csv' },
  }));
  const { blob, filename } = await api.downloadConnectionsCsv();
  assert.equal(calls[0].url, "/api/devices/connections.csv");
  assert.equal(filename, "lab-connections-2026-10-20.csv");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)], [239, 187, 191]);
  assert.match(await blob.text(), /OPT2,192\.0\.2\.2/);
});

test("CSV download accepts quoted filenames and falls back for unrelated filenames", async t => {
  stubFetch(t, new Response("Server", { headers: { "Content-Disposition": 'attachment; filename="lab-connections-2026-10-20.csv"' } }));
  assert.equal((await api.downloadConnectionsCsv()).filename, "lab-connections-2026-10-20.csv");
  stubFetch(t, new Response("Server", { headers: { "Content-Disposition": 'attachment; filename="other.csv"' } }));
  assert.equal((await api.downloadConnectionsCsv()).filename, "lab-connections.csv");
});

test("CSV errors preserve status and detail instead of downloading an error document", async t => {
  stubFetch(t, new Response(JSON.stringify({ detail: "Operator role needed" }), { status: 403 }));
  await assert.rejects(api.downloadConnectionsCsv(), error => error.status === 403 && error.message === "Operator role needed");
  stubFetch(t, new Response("Bad gateway", { status: 502 }));
  await assert.rejects(api.downloadConnectionsCsv(), error => error.status === 502 && error.message === "CSV download failed (502)");
});

test("search also finds a server by its U slot", () => {
  const placed = [{ ...servers[0], slot: 12 }, { ...servers[1], slot: null }];
  assert.deepEqual(keys(filterConnections(placed, { search: "U12" })), ["opt2"]);
  assert.deepEqual(keys(filterConnections(placed, { search: "u12" })), ["opt2"]);
  assert.deepEqual(filterConnections(placed, { search: "Unull" }), []);
});

test("Connections and Locations share one Export CSV button for the same download", () => {
  const button = readFileSync(new URL("../components/ExportCsvButton.jsx", import.meta.url), "utf8");
  assert.match(button, />\s*\{busy \? "Exporting…" : "Export CSV"\}/);
  assert.match(button, /api\.downloadConnectionsCsv\(\)/);
  assert.match(button, /disabled=\{!canOperate \|\| busy \|\| disabled\}/);
  for (const page of ["ConnectionsView.jsx", "LocationsView.jsx"]) {
    const pageSource = readFileSync(new URL(`../pages/${page}`, import.meta.url), "utf8");
    assert.match(pageSource, /import ExportCsvButton from "\.\.\/components\/ExportCsvButton";/, page);
    assert.match(pageSource, /<ExportCsvButton\b/, page);
    assert.doesNotMatch(pageSource, /downloadConnectionsCsv/, `${page} downloads only through the shared button`);
  }
});

test("Locations has its own shareable query and Back restores it", () => {
  const app = navigationHarness();
  app.actions().navigateAdmin("locations");
  assert.equal(new URL(app.window.location.href).searchParams.get("tab"), "locations");
  assert.equal(app.state.mainTab, "admin");
  assert.equal(app.state.adminSection, "locations");
  const locationsEntry = app.history.state;
  app.actions().navigateAdmin("connections");
  assert.equal(app.state.adminSection, "connections");
  app.pop({ state: locationsEntry });
  assert.equal(app.state.adminSection, "locations");
  app.pop({ state: null });   // the URL now says ?tab=connections
  assert.equal(app.state.adminSection, "connections");
  app.actions().navigate("sync");
  assert.equal(app.state.mainTab, "admin");
  assert.equal(app.state.adminSection, "mapping");
});

test("Racks: ?rack= opens a rack; Back between a rack and all racks keeps Edit mode, other Back leaves it", () => {
  const h = navigationHarness();
  const { navigate } = h.actions();
  navigate("racks", "Rack-04");
  assert.equal(h.state.openRack, "Rack-04");
  assert.match(h.window.location.search, /[?&]rack=Rack-04/);
  h.state.editMode = true;
  h.window.location.search = "?tab=racks";
  h.pop({ state: { tab: "racks", view: { kind: "dashboard" }, rack: null } });
  assert.equal(h.state.openRack, null);
  assert.equal(h.state.mainTab, "racks");
  assert.equal(h.state.editMode, true, "closing the rack with Back stays in Edit mode");
  h.window.location.search = "?tab=dashboard";
  h.pop({ state: { tab: "dashboard", view: { kind: "dashboard" } } });
  assert.equal(h.state.editMode, false, "leaving Racks with Back leaves Edit mode");
});
