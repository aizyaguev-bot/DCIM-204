import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api } from "../api/client.js";

// Run the view's exported pure helpers without a JSX loader or browser globals.
const source = readFileSync(new URL("../pages/ConnectionsView.jsx", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("export function connectionRacks"), source.indexOf("\nfunction ConnectionList"));
const { connectionRacks, filterConnections, connectionsLoader } = await import(`data:text/javascript;base64,${Buffer.from(helpers).toString("base64")}`);
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
  const setters = ["view", "mainTab", "editMode", "adminSection"].map(key => value => { state[key] = value; });
  const actions = () => new Function("window", "history", "setView", "setMainTab", "setEditMode", "setAdminSection", "adminSection", `${navigationSource}; return { navigate, navigateAdmin };`)(window, history, ...setters, state.adminSection);
  const pop = new Function("location", "setView", "setMainTab", "setEditMode", "setAdminSection", `${popSource}; return onPop;`)(window.location, ...setters);
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

test("search ignores hidden device ids such as pdu3 or a uuid (CONN-3)", () => {
  const hidden = [
    { key: "opt7", name: "OPT7", server_ip: "192.0.2.7", rack: "Rack-1", owner: "Ada", ping_status: "up",
      pdu: [{ device_id: "pdu3", device_name: "PDU-Left", device_ip: "192.0.2.40", rack: "Rack-1", port: 5, label: "OPT7 PSU", state: "on" }],
      kvm: [{ device_id: "9c1e7f02-5b6d-4e1a-9a55-0d3f1c2b7e41", device_name: "Console-Left", device_ip: "192.0.2.41", port: 6, label: "OPT7" }] },
  ];
  assert.deepEqual(filterConnections(hidden, { search: "U3" }), [], "pdu3 has no slot, so U3 must not match its id");
  assert.deepEqual(filterConnections(hidden, { search: "9c1e" }), [], "the KVM uuid is not shown, so it must not match");
  assert.deepEqual(filterConnections(hidden, { search: "pdu3" }), []);
  assert.deepEqual(keys(filterConnections(hidden, { search: "PDU-Left" })), ["opt7"], "the shown device name still matches");
  assert.deepEqual(keys(filterConnections(hidden, { search: "opt7" })), ["opt7"], "the server key still matches");
  const placed = [...hidden, { key: "opt3", name: "OPT3", slot: 3, pdu: [], kvm: [] }];
  assert.deepEqual(keys(filterConnections(placed, { search: "U3" })), ["opt3"], "a real U3 server is still found");
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function loaderHarness({ hidden = false } = {}) {
  const events = [];
  const requests = [];
  const state = { hidden };
  const fetchConnections = () => { const call = deferred(); requests.push(call); return call.promise; };
  const loader = connectionsLoader(fetchConnections, {
    onStart: () => events.push("start"),
    onData: result => events.push(["data", result]),
    onError: (e, background) => events.push(["error", e.message, background]),
    onDenied: () => events.push("denied"),
    onDone: () => events.push("done"),
    isHidden: () => state.hidden,
  });
  return { events, requests, state, loader };
}

test("background refresh replaces the data without a visible loading state (CONN-1)", async () => {
  const { events, requests, loader } = loaderHarness();
  const first = loader.load(false);
  requests[0].resolve({ generated_at: "1" });
  await first;
  const second = loader.load(true);
  requests[1].resolve({ generated_at: "2" });
  assert.equal(await second, true);
  assert.deepEqual(events, ["start", ["data", { generated_at: "1" }], "done", ["data", { generated_at: "2" }]]);
});

test("background refresh is skipped while the tab is hidden or a load is still running", async () => {
  const { events, requests, state, loader } = loaderHarness({ hidden: true });
  assert.equal(await loader.load(true), false, "hidden tab: no request");
  assert.equal(requests.length, 0);
  const visible = loader.load(false);   // a visible load still runs in a hidden tab (first open)
  assert.equal(requests.length, 1);
  state.hidden = false;
  assert.equal(await loader.load(true), false, "pending guard: no overlapping request");
  assert.equal(requests.length, 1);
  requests[0].resolve({ servers: [] });
  await visible;
  assert.equal(await Promise.race([loader.load(true), Promise.resolve("pending")]), "pending");
  assert.equal(requests.length, 2, "the guard is released after the first load");
  requests[1].resolve({ servers: [] });
  assert.deepEqual(events.filter(event => event === "start"), ["start"]);
});

test("a failed background refresh reports the error but never clears the data; a 403 stops the cycle", async () => {
  const { events, requests, loader } = loaderHarness();
  const first = loader.load(false);
  requests[0].resolve({ servers: ["kept"] });
  await first;
  const failed = loader.load(true);
  requests[1].reject(Object.assign(new Error("502: Bad gateway"), { status: 502 }));
  await failed;
  assert.deepEqual(events.at(-1), ["error", "502: Bad gateway", true]);
  assert.ok(!events.some(event => Array.isArray(event) && event[0] === "data" && event[1] == null), "no data reset on error");
  const denied = loader.load(true);
  requests[2].reject(Object.assign(new Error("Operator role needed"), { status: 403 }));
  await denied;
  assert.equal(events.at(-1), "denied");
  assert.equal(await loader.load(true), false, "no more requests after a 403");
  assert.equal(await loader.load(false), false);
  assert.equal(requests.length, 3);
});

test("a response that arrives after stop() is ignored, so a slow old request never overwrites newer data", async () => {
  const { events, requests, loader } = loaderHarness();
  const old = loader.load(false);
  loader.stop();
  requests[0].resolve({ generated_at: "old" });
  await old;
  assert.deepEqual(events, ["start"], "no data and no done after stop");
  const failed = loaderHarness();
  const late = failed.loader.load(true);
  failed.loader.stop();
  failed.requests[0].reject(Object.assign(new Error("Forbidden"), { status: 403 }));
  await late;
  assert.deepEqual(failed.events, [], "no late error or denial after stop");
  assert.equal(await loader.load(true), false, "a stopped loader sends nothing");
});

test("Connections polls on the account refresh interval and isolates Hebrew text direction (CONN-1, CONN-6)", () => {
  const view = source.slice(source.indexOf("export default function ConnectionsView"));
  assert.match(view, /const \{ canOperate, preferences \} = useAccounts\(\);/);
  assert.match(view, /setInterval\(\(\) => loader\.load\(true\), preferences\.refresh_seconds \* 1000\)/);
  assert.match(view, /clearInterval\(timer\)/);
  assert.match(view, /loader\.stop\(\)/);
  assert.match(view, /\}, \[canOperate, refresh, preferences\.refresh_seconds\]\);/);
  assert.match(view, /isHidden: \(\) => document\.hidden/);
  assert.match(view, /<th scope="row" dir="auto"[^>]*>\{server\.name\}<\/th>/);
  assert.match(view, /<h2 dir="auto"[^>]*>\{server\.name\}<\/h2>/);
  assert.match(view, /<td className="p-3" dir="auto">\{server\.owner \|\| "—"\}<\/td>/);
  assert.match(view, /<dd dir="auto">\{server\.owner \|\| "—"\}<\/dd>/);
  assert.match(source, /<span className="text-zinc-200" dir="auto">\{link\.device_name\}<\/span>/);
  assert.match(source, /<div className="text-xs text-zinc-500 break-words" dir="auto">\{link\.label\}<\/div>/);
  assert.doesNotMatch(view, /setData\(null\);\s*\n?\s*if \(e\.status === 403\)/, "a failed refresh no longer drops the rows");
});
