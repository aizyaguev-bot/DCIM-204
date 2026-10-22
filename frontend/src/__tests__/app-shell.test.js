import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dashboardStats } from "../dashboardStats.js";

// App.jsx needs a JSX loader, so its plain-JS functions are cut from the source and run with stubs.
const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
function slice(start, end) {
  const from = app.indexOf(start);
  assert.ok(from >= 0, `App.jsx contains ${start}`);
  const to = app.indexOf(end, from + start.length);
  assert.ok(to > from, `App.jsx contains ${end} after ${start}`);
  return app.slice(from, to);
}
const fn = (names, source, result) => new Function(...names, `${source}\nreturn ${result};`);

test("detail pages remount for each device so a label draft never carries over", () => {
  assert.match(app, /<PduDetail key=\{`pdu:\$\{view\.id\}`\}/);
  assert.match(app, /<KvmDetail key=\{`kvm:\$\{view\.id\}`\}/);
  assert.match(app, /<RemovedDevice /);
  assert.match(app, /This device was removed\./);
});

test("the frozen navigate and onPop regions know nothing about racks or consoles", () => {
  const nav = slice("  function navigate(", "  function openDetail(");
  const pop = slice("    const onPop =", '    window.addEventListener("popstate"');
  for (const region of [nav, pop]) {
    assert.doesNotMatch(region, /setRackParam|rackParam|inlineConsole|kvmConsole/);
  }
  // The extra listeners come after the original popstate registration, which the region ends at.
  assert.ok(app.indexOf('window.addEventListener("popstate", onHistory)') > app.indexOf('window.addEventListener("popstate", onPop)'));
  assert.match(slice("    const onHistory =", "    const onPageHide ="), /setRackParam\(new URLSearchParams\(window\.location\.search\)\.get\("rack"\)\)/);
  assert.match(app, /window\.addEventListener\("pagehide", onPageHide\)/);
});

test("KVM stats count an offline KVM as an alert, like an offline PDU", () => {
  const pdus = [{ id: "p1" }, { id: "p2" }];
  const kvms = [{ id: "k1" }, { id: "k2" }, { id: "k3" }];
  const stats = dashboardStats(pdus, kvms,
    { p1: { reachable: true, total_watts: 10, watts_complete: true, outlets: [{ state: "on" }, { state: "off" }] }, p2: { reachable: false, outlets: [] } },
    { k1: { reachable: false, ports: [] }, k2: { requestFailed: true, ports: [] }, k3: { reachable: true, ports: [{ label: "OPT1" }, { label: "Port 2" }] } });
  assert.equal(stats.alerts, 2, "one offline PDU and one offline KVM; a failed status request is not an alert");
  assert.equal(stats.deviceCount, 5);
  assert.equal(stats.outletsOn, 1);
  assert.equal(stats.portsMapped, 1);
  assert.equal(stats.portsTotal, 2);
  assert.equal(dashboardStats([], [{ id: "k" }], {}, { k: { reachable: true, error: "Sign-in rejected", ports: [] } }).alerts, 0);
  assert.equal(dashboardStats([], [{ id: "k" }]).alerts, 0, "no reading yet is not an alert");
  assert.match(app, /useMemo\(\(\) => dashboardStats\(pdus, kvms, pduStatuses, kvmStatuses\)/);
});

function consoleHarness({ inUse = false, confirmAnswer = true, popup = null, markOk = true, lease = "a".repeat(32), noLease = false } = {}) {
  const calls = { open: [], fetch: [], confirm: [], pushState: [], released: [], shown: [], errors: [], status: [] };
  const window = {
    open: url => { calls.open.push(url); return popup; },
    confirm: text => { calls.confirm.push(text); return confirmAnswer; },
  };
  const history = { state: { view: { kind: "kvm", id: "kvm1" } }, pushState(value) { calls.pushState.push(value); this.state = value; } };
  const fetch = async (url, init) => {
    calls.fetch.push({ url, init });
    return { ok: markOk, json: async () => (noLease ? { ok: true } : { ok: true, lease }) };
  };
  const inlineConsoleRef = { current: null };
  const deps = {
    setKvmOpenError: text => { if (text) calls.errors.push(text); },
    canOperate: true,
    devices: [{ id: "kvm1", name: "KVM 01" }],
    kvmStatuses: { kvm1: { ports: [{ number: 1, label: "OPT11", in_use: inUse }, { number: 3, label: "", in_use: false }] } },
    window, history, fetch,
    loadKvmStatus: id => calls.status.push(id),
    kvmTimers: { current: new Set() },
    releasePort: (...args) => calls.released.push(args),
    inlineConsoleRef,
    showInlineConsole: value => { inlineConsoleRef.current = value; calls.shown.push(value); },
    setInterval: () => 1,
  };
  const open = fn(Object.keys(deps), slice("  function openKvmConsole(", "  function showInlineConsole("), "openKvmConsole")(...Object.values(deps));
  return { open, calls, inlineConsoleRef, history };
}

test("an in-use port asks first; Cancel opens and marks nothing", () => {
  const h = consoleHarness({ inUse: true, confirmAnswer: false });
  h.open("kvm1", 1);
  assert.equal(h.calls.confirm.length, 1);
  assert.match(h.calls.confirm[0], /OPT11/);
  assert.match(h.calls.confirm[0], /בשימוש/);
  assert.deepEqual([h.calls.open, h.calls.fetch, h.calls.shown], [[], [], []]);
  const free = consoleHarness({ inUse: false });
  free.open("kvm1", 1);
  assert.equal(free.calls.confirm.length, 0, "a free port opens without a question");
});

test("mark-in-use refreshes the KVM status and resolves to the lease", async () => {
  const h = consoleHarness();
  h.open("kvm1", 1);
  assert.equal(h.calls.fetch[0].url, "/api/kvms/kvm1/ports/1/mark-in-use");
  const shown = h.calls.shown[0];
  assert.equal(await shown.leaseP, "a".repeat(32));
  assert.deepEqual(h.calls.status, ["kvm1"], "IN USE shows without waiting for the next poll");
  const chain = slice("    const leaseP = fetch(", "    if (popup) {");
  assert.match(chain, /loadKvmStatus\(deviceId\)/);

  const old = consoleHarness({ noLease: true });
  old.open("kvm1", 1);
  assert.equal(await old.calls.shown[0].leaseP, "", "a server without leases gives an empty lease");

  const failed = consoleHarness({ markOk: false });
  failed.open("kvm1", 1);
  assert.equal(await failed.calls.shown[0].leaseP, null, "failed marking: nothing to free later");
  assert.equal(failed.calls.errors.length, 1);
  assert.deepEqual(failed.calls.status, []);
});

test("an inline console gets a history entry; a replacement frees the port it held", () => {
  const h = consoleHarness();
  h.open("kvm1", 3);
  assert.equal(h.calls.pushState.length, 1);
  assert.equal(h.calls.pushState[0].kvmConsole, true);
  assert.deepEqual(h.calls.pushState[0].view, { kind: "kvm", id: "kvm1" }, "the page's own history state is kept");
  const first = h.inlineConsoleRef.current;
  h.open("kvm1", 1);
  assert.equal(h.calls.pushState.length, 1, "one history entry for the console, however often it is replaced");
  assert.deepEqual(h.calls.released.map(([device, port, leaseP, options]) => [device, port, leaseP === first.leaseP, options]),
    [["kvm1", 3, true, { leaseOnly: false }]]);
  h.open("kvm1", 1);
  assert.deepEqual(h.calls.released[1][3], { leaseOnly: true }, "the same port is freed only with a lease");

  const popup = consoleHarness({ popup: { closed: false } });
  popup.open("kvm1", 1);
  assert.deepEqual([popup.calls.shown, popup.calls.pushState], [[], []], "a popup console stays out of the page history");
});

function releaseHarness() {
  const calls = { fetch: [], status: [] };
  const fetch = async (url, init) => { calls.fetch.push({ url, init }); return { ok: true }; };
  const release = fn(["fetch", "loadKvmStatus"], slice("  async function releasePort(", "  useEffect(() => () => {"), "releasePort")(fetch, id => calls.status.push(id));
  return { release, calls };
}

test("releasePort frees only this session's lease, and only after marking succeeded", async () => {
  let h = releaseHarness();
  await h.release("kvm1", 1, Promise.resolve(null));
  assert.deepEqual(h.calls.fetch, [], "marking failed: no mark-free");

  h = releaseHarness();
  await h.release("kvm1", 1, Promise.resolve("b".repeat(32)));
  assert.equal(h.calls.fetch[0].url, "/api/kvms/kvm1/ports/1/mark-free", "the lease never goes in the URL");
  assert.deepEqual(JSON.parse(h.calls.fetch[0].init.body), { lease: "b".repeat(32) });
  assert.equal(h.calls.fetch[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(h.calls.status, ["kvm1"]);

  h = releaseHarness();
  await h.release("kvm1", 2, Promise.resolve(""));
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0].init.body, undefined, "no lease from an older server: no body");

  h = releaseHarness();
  await h.release("kvm1", 2, Promise.resolve(""), { leaseOnly: true });
  assert.deepEqual(h.calls.fetch, []);

  h = releaseHarness();
  await h.release("kvm1", 4, Promise.resolve("c"), { keepalive: true });
  assert.equal(h.calls.fetch[0].init.keepalive, true);
  assert.deepEqual(h.calls.status, [], "no status refresh while the page is going away");
});

test("closing the inline console frees its port and leaves its history entry", () => {
  const calls = { released: [], back: 0 };
  const consoleState = { deviceId: "kvm1", port: 4, leaseP: Promise.resolve("d") };
  const make = state => {
    const inlineConsoleRef = { current: consoleState };
    const history = { state, back() { calls.back++; } };
    return fn(["inlineConsoleRef", "showInlineConsole", "releasePort", "history"], slice("  function closeInlineConsole(", "  const closeConsoleRef"), "closeInlineConsole")(
      inlineConsoleRef, value => { inlineConsoleRef.current = value; }, (...args) => calls.released.push(args), history);
  };
  const close = make({ kvmConsole: true });
  close();
  close();
  assert.equal(calls.released.length, 1, "a second close does nothing");
  assert.deepEqual(calls.released[0].slice(0, 2), ["kvm1", 4]);
  assert.equal(calls.back, 1, "closing from the page goes back over the console's entry");
  make({ kvmConsole: false })({ fromHistory: true });
  assert.equal(calls.back, 1, "Back already left the entry");
  make({ kvmConsole: true })({ fromHistory: true, keepalive: true });
  assert.deepEqual(calls.released.at(-1)[3], { keepalive: true });
  assert.equal(calls.back, 1);
});

function devicesHarness() {
  const state = { devices: [], sets: 0, error: "x", loading: true };
  const pending = [];
  const api = { getDevices: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
  const deps = {
    api, devicesSeq: { current: 0 }, devicesJson: { current: "" },
    setDevices: value => { state.devices = value; state.sets++; },
    setDeviceError: value => { state.error = value; },
    setLoading: value => { state.loading = value; },
    errorMessage: e => e.message,
  };
  const load = fn(Object.keys(deps), slice("  async function loadDevices() {", "  async function loadPduStatus("), "loadDevices")(...Object.values(deps));
  return { load, state, pending, deps };
}

test("loadDevices returns the list, keeps an unchanged array and ignores stale answers", async () => {
  const h = devicesHarness();
  const first = h.load();
  h.pending[0].resolve([{ id: "a" }]);
  assert.deepEqual(await first, [{ id: "a" }]);
  assert.equal(h.state.sets, 1);
  assert.equal(h.state.error, "");
  const kept = h.state.devices;
  const again = h.load();
  h.pending[1].resolve([{ id: "a" }]);
  await again;
  assert.equal(h.state.devices, kept, "same JSON: same array, so status polling is not restarted");

  const older = h.load();
  const newer = h.load();
  h.pending[3].resolve([{ id: "a" }, { id: "b" }]);
  await newer;
  h.pending[2].resolve([{ id: "a" }]);
  assert.deepEqual(await older, [{ id: "a" }], "the caller still gets what was fetched");
  assert.deepEqual(h.state.devices.map(d => d.id), ["a", "b"], "an older answer never replaces a newer one");

  const failing = h.load();
  h.pending[4].reject(new Error("offline"));
  assert.equal(await failing, undefined);
  assert.equal(h.state.error, "offline");
  assert.equal(h.state.loading, false);
});

test("the device list is polled in its own effect, not in the [devices] status effect", () => {
  const poll = slice("  useEffect(() => {\n    const timer = setInterval(() => { loadDevices(); }", "  }, [preferences.refresh_seconds]);");
  assert.match(poll, /preferences\.refresh_seconds \* 1000/);
  const statusEffect = slice("    if (devices.length === 0) return;", "  }, [devices, preferences.refresh_seconds]);");
  assert.doesNotMatch(statusEffect, /loadDevices/);
});

test("a 409 on labels reloads and hands the fresh device to the editor", async () => {
  const run = async (list) => {
    const order = [];
    const conflict = Object.assign(new Error("409: changed"), { status: 409 });
    const save = fn(["api", "loadDevices", "refreshAllStatuses"], slice("  async function saveLabels(", "  // The X clears"), "saveLabels")(
      { updateLabels: async () => { order.push("patch"); throw conflict; } },
      async () => { order.push("load"); return list; },
      async () => { order.push("statuses"); });
    const error = await save("pdu1", {}, "rev").catch(e => e);
    return { error, order };
  };
  const { error, order } = await run([{ id: "pdu0" }, { id: "pdu1", labels: { 4: "NEW" } }]);
  assert.equal(error.status, 409);
  assert.deepEqual(error.latest, { id: "pdu1", labels: { 4: "NEW" } });
  assert.deepEqual(order, ["patch", "load", "statuses"]);
  assert.equal((await run(undefined)).error.latest, undefined, "reload failed: no latest device");
});

test("removing a device: a 404 counts as removed and stale lists cannot bring it back", async () => {
  const run = async (failure) => {
    const state = { devices: [{ id: "a", name: "PDU A" }, { id: "b", name: "PDU B" }], alerts: [] };
    const devicesSeq = { current: 5 };
    const remove = fn(["devices", "confirm", "alert", "api", "errorMessage", "devicesSeq", "devicesJson", "setDevices"],
      slice("  async function handleDeleteDevice(", "  const match ="), "handleDeleteDevice")(
      state.devices, () => true, text => state.alerts.push(text),
      { deleteDevice: async () => { if (failure) throw failure; } }, e => e.message, devicesSeq, { current: "[]" },
      update => { state.devices = update(state.devices); });
    return { result: await remove("a"), state, seq: devicesSeq.current };
  };
  let r = await run(null);
  assert.deepEqual([r.result, r.state.devices.map(d => d.id), r.seq], [true, ["b"], 6]);
  r = await run(Object.assign(new Error("Device not found"), { status: 404 }));
  assert.deepEqual([r.result, r.state.devices.map(d => d.id), r.state.alerts], [true, ["b"], []]);
  r = await run(Object.assign(new Error("Server error"), { status: 500 }));
  assert.deepEqual([r.result, r.state.devices.length, r.seq], [false, 2, 5]);
  assert.match(r.state.alerts[0], /Could not remove PDU A: Server error/);
});

test("Mark KVM free names the ports it clears and does nothing on Cancel", async () => {
  const run = async (answer) => {
    const calls = { confirm: [], marked: [], status: [] };
    const free = fn(["devices", "kvmStatuses", "window", "api", "loadKvmStatus"], slice("  async function handleMarkKvmFree(", "  async function handleOutletAction("), "handleMarkKvmFree")(
      [{ id: "kvm1", name: "KVM 01" }],
      { kvm1: { ports: [{ number: 1, label: "OPT11", in_use: true }, { number: 2, label: "OPT12", in_use: false }, { number: 4, label: "", in_use: true }] } },
      { confirm: text => { calls.confirm.push(text); return answer; } },
      { markKvmFree: async id => { calls.marked.push(id); } },
      async id => { calls.status.push(id); });
    await free("kvm1");
    return calls;
  };
  const cancelled = await run(false);
  assert.match(cancelled.confirm[0], /KVM 01/);
  assert.match(cancelled.confirm[0], /OPT11 \(P1\), P4/);
  assert.doesNotMatch(cancelled.confirm[0], /OPT12/);
  assert.deepEqual(cancelled.marked, []);
  const accepted = await run(true);
  assert.deepEqual([accepted.marked, accepted.status], [["kvm1"], ["kvm1"]]);
});

test("rack selection is its own history entry and tab changes clear it", () => {
  const harness = (rackParam, href = "https://example.test/?tab=racks") => {
    const calls = { push: [], rack: [], navigate: [] };
    const window = { location: { href } };
    const history = { pushState: (state, title, url) => calls.push.push({ state, url: String(url) }) };
    const source = slice("  // navigate() plus the rack", "  useEffect(() => {\n    const onPop");
    const { selectRack, goTo } = fn(["window", "history", "setRackParam", "rackParam", "adminSection", "navigate", "navigateAdmin"], source, "{ selectRack, goTo }")(
      window, history, value => calls.rack.push(value), rackParam, "devices", (...args) => calls.navigate.push(args), () => {});
    return { selectRack, goTo, calls };
  };
  let h = harness(null);
  h.selectRack("Rack-02");
  assert.equal(new URL(h.calls.push[0].url).searchParams.get("rack"), "Rack-02");
  assert.equal(new URL(h.calls.push[0].url).searchParams.get("tab"), "racks");
  assert.deepEqual(h.calls.push[0].state, { tab: "racks", view: { kind: "dashboard" }, adminSection: "devices" });
  assert.deepEqual([h.calls.rack, h.calls.navigate], [["Rack-02"], []], "no navigate(): Edit mode stays");
  h = harness("Rack-02", "https://example.test/?tab=dcim&rack=Rack-02");
  h.selectRack(null);
  const url = new URL(h.calls.push[0].url);
  assert.deepEqual([url.searchParams.get("tab"), url.searchParams.has("rack"), h.calls.rack], ["racks", false, [null]]);
  h = harness("Rack-02");
  h.selectRack("Rack-02");
  assert.deepEqual(h.calls.push, [], "the rack already shown adds no history entry");
  h.goTo("racks");
  h.goTo("racks", "Rack-03");
  assert.deepEqual(h.calls.rack, [null, "Rack-03"]);
  assert.deepEqual(h.calls.navigate, [["racks", undefined], ["racks", "Rack-03"]]);
  assert.match(app, /<DcimView section=\{mainTab\}[^>]*\n\s*rack=\{rackParam\} onRackChange=\{selectRack\}/);
  assert.match(app, /onNavigate=\{goTo\}/);
  assert.match(app, /navigate=\{goTo\} openDetail=\{openDetail\}/);
});
