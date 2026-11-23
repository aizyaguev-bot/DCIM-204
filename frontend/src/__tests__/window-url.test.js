import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WINDOW_DROP_PARAMS, assistantDetail, legacyViewTarget, parseWindow, sameWindow, twinOpenRequest, windowHref, windowId,
  windowSearch, windowTarget } from "../window/windowUrl.js";

// The window part of the address (v2 §W.1): srv=<key> for servers, open=<kind>:<id> for every other kind, sec=.
const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../App.jsx");

test("parseWindow reads srv= and open=<kind>:<id> (split at the first colon) with an optional sec", () => {
  assert.deepEqual(parseWindow("?tab=dashboard&srv=opt11"), { kind: "server", id: "opt11" });
  assert.deepEqual(parseWindow("?tab=racks&srv=OPT11&sec=units"), { kind: "server", id: "opt11", sec: "units" });
  assert.deepEqual(parseWindow("?srv=kvm%20power"), { kind: "server", id: "kvm power" }, "the window decides it is no server");
  assert.deepEqual(parseWindow("?tab=dashboard&open=dev:pdu8"), { kind: "dev", id: "pdu8" });
  assert.deepEqual(parseWindow("?open=unit:u-pc300&sec=delete"), { kind: "unit", id: "u-pc300", sec: "delete" });
  assert.deepEqual(parseWindow("?open=twin:ITEM-0044"), { kind: "twin", id: "ITEM-0044" }, "3D ids keep their case");
  assert.deepEqual(parseWindow("?open=rack:Rack-01"), { kind: "rack", id: "Rack-01" });
  assert.deepEqual(parseWindow("?open=cooling:ch1"), { kind: "cooling", id: "ch1" });
  assert.deepEqual(parseWindow("?open=dev:a:b"), { kind: "dev", id: "a:b" }, "only the first colon splits");
  assert.deepEqual(parseWindow("?srv=opt11&open=dev:pdu1"), { kind: "server", id: "opt11" }, "srv wins over open");
  assert.equal(parseWindow("?open=server:opt11"), null, "servers use srv=");
  assert.equal(parseWindow("?open=nope:x"), null);
  assert.equal(parseWindow("?open=dev:"), null);
  assert.equal(parseWindow("?open=pdu8"), null);
  assert.equal(parseWindow("?srv=%20"), null);
  assert.equal(parseWindow("?tab=racks"), null);
  assert.equal(parseWindow(""), null);
  assert.deepEqual(parseWindow("?srv=opt11&sec=junk"), { kind: "server", id: "opt11" }, "an unknown section is ignored");
});

test("windowSearch writes one window and keeps every other parameter", () => {
  assert.equal(windowSearch("?tab=dashboard", { kind: "server", id: "OPT11" }), "?tab=dashboard&srv=opt11");
  assert.equal(windowSearch("?tab=racks&rack=Rack-01&srv=opt11", { kind: "dev", id: "pdu8", sec: "delete" }), "?tab=racks&rack=Rack-01&open=dev:pdu8&sec=delete");
  assert.equal(windowSearch("?tab=racks&open=dev:pdu8&sec=delete", { kind: "server", id: "opt12" }), "?tab=racks&srv=opt12", "sec goes with the window");
  assert.equal(windowSearch("?tab=racks&srv=opt11&sec=units", null), "?tab=racks");
  assert.equal(windowSearch("?srv=opt11", null), "");
  assert.equal(windowSearch("?tab=x", { kind: "bogus", id: "1" }), "?tab=x");
  const href = windowHref("https://lab.test/?tab=twin&select=srv%3Aopt12#h", { kind: "server", id: "opt12" });
  assert.equal(href, "https://lab.test/?tab=twin&select=srv:opt12&srv=opt12#h");
  for (const target of [{ kind: "server", id: "opt11", sec: "move" }, { kind: "dev", id: "a:b" }, { kind: "twin", id: "ITEM-0044" }]) {
    assert.deepEqual(parseWindow(windowSearch("?tab=dashboard", target)), target, `${windowId(target)} survives a round trip`);
  }
});

test("helpers: windowTarget, sameWindow, windowId and old PDU / KVM detail history entries", () => {
  assert.deepEqual(windowTarget("server", " OPT11 ", "activity"), { kind: "server", id: "opt11", sec: "activity" });
  assert.equal(windowTarget("server", ""), null);
  assert.equal(windowTarget("dev", "x".repeat(301)), null);
  assert.ok(sameWindow({ kind: "dev", id: "pdu1", sec: "delete" }, { kind: "dev", id: "pdu1" }));
  assert.ok(!sameWindow({ kind: "dev", id: "pdu1" }, { kind: "unit", id: "pdu1" }));
  assert.ok(!sameWindow(null, { kind: "dev", id: "pdu1" }));
  assert.equal(windowId({ kind: "server", id: "opt11" }), "server:opt11");
  assert.deepEqual(legacyViewTarget({ view: { kind: "pdu", id: "pdu2" }, tab: "dashboard" }), { kind: "dev", id: "pdu2" });
  assert.deepEqual(legacyViewTarget({ view: { kind: "kvm", id: "kvm1" } }), { kind: "dev", id: "kvm1" });
  assert.equal(legacyViewTarget({ view: { kind: "dashboard" } }), null);
  assert.equal(legacyViewTarget(null), null);
});

test("twin messages: twin:open with a target, v1's twin:open-server, moveTo kept only when well formed", () => {
  assert.deepEqual(twinOpenRequest({ type: "twin:open", target: { kind: "server", id: "OPT21", sec: "move", moveTo: { rack: "Rack-02", u: 3 } } }),
    { target: { kind: "server", id: "opt21", sec: "move" }, moveTo: { rack: "Rack-02", u: 3 } });
  assert.deepEqual(twinOpenRequest({ type: "twin:open", target: { kind: "twin", id: "ITEM-0045", sec: "delete" } }),
    { target: { kind: "twin", id: "ITEM-0045", sec: "delete" }, moveTo: null });
  assert.deepEqual(twinOpenRequest({ type: "twin:open-server", key: "opt11" }), { target: { kind: "server", id: "opt11" }, moveTo: null });
  assert.equal(twinOpenRequest({ type: "twin:open-server", key: "opt11", moveTo: { rack: 3, u: "x" } }).moveTo, null);
  assert.equal(twinOpenRequest({ type: "twin:open", target: { kind: "evil", id: "x" } }), null);
  assert.equal(twinOpenRequest({ type: "twin:selected", ref: "srv:opt11" }), null);
  assert.equal(twinOpenRequest(null), null);
});

test("the assistant's context detail follows the open window", () => {
  const devices = [{ id: "pdu1", kind: "pdu" }, { id: "kvm1", kind: "kvm" }, { id: "rack6", kind: "rack" }];
  assert.deepEqual(assistantDetail({ kind: "server", id: "opt11" }, devices), { kind: "server", id: "opt11" });
  assert.deepEqual(assistantDetail({ kind: "dev", id: "kvm1" }, devices), { kind: "kvm", id: "kvm1" });
  assert.equal(assistantDetail({ kind: "dev", id: "rack6" }, devices), null);
  assert.deepEqual(assistantDetail({ kind: "unit", id: "ci-1" }, devices), { kind: "item", id: "ci-1" });
  assert.deepEqual(assistantDetail({ kind: "rack", id: "Rack-01" }, devices), { kind: "rack", id: "Rack-01" });
  assert.equal(assistantDetail({ kind: "twin", id: "ITEM-1" }, devices), null);
  assert.equal(assistantDetail(null, devices), null);
  assert.match(app, /detail: assistantDetail\(windowTarget, devices\)/);
});

// App's navigate() and selectRack() run as written, with stubs (as app-shell.test.js does).
function slice(start, end) {
  const from = app.indexOf(start);
  assert.ok(from >= 0, `App.jsx contains ${start}`);
  const to = app.indexOf(end, from + start.length);
  assert.ok(to > from);
  return app.slice(from, to);
}

test("navigate() and selectRack() drop the window, a Racks unit and a highlighted row; the twin keeps them", () => {
  assert.deepEqual(WINDOW_DROP_PARAMS, ["srv", "open", "sec", "item", "focus"]);
  const pushed = [];
  const history = { pushState: (state, title, url) => pushed.push(String(url)) };
  const navigate = new Function("window", "history", "setView", "setMainTab", "setEditMode", "setAdminSection", "adminSection",
    `${slice("  function navigate(", "  function navigateAdmin(")}; return navigate;`)(
    { location: { href: "https://lab.test/?tab=dashboard&srv=opt11&sec=units&item=ci-1&focus=opt11&open=dev:pdu1" } }, history, () => {}, () => {}, () => {}, () => {}, "devices");
  navigate("racks");
  const q = new URL(pushed[0]).searchParams;
  assert.deepEqual(WINDOW_DROP_PARAMS.filter(name => q.has(name)), []);
  assert.equal(q.get("tab"), "racks");
  const source = slice("  // navigate() plus the rack", "  useEffect(() => {\n    const onPop");
  const { selectRack } = new Function("window", "history", "setRackParam", "rackParam", "adminSection", "navigate", "navigateAdmin", `${source}\nreturn { selectRack };`)(
    { location: { href: "https://lab.test/?tab=racks&srv=opt11&open=unit:ci-1&item=ci-1" } }, history, () => {}, null, "devices", () => {}, () => {});
  selectRack("Rack-02");
  const r = new URL(pushed[1]).searchParams;
  assert.deepEqual([r.get("rack"), r.has("srv"), r.has("open"), r.has("item")], ["Rack-02", false, false, false]);
  // The twin's own address change (?select=) replaces the entry and keeps the window (twinSelectedAddress keeps every
  // other parameter).
  assert.match(app, /const next = twinSelectedAddress\(window\.location\.href, ref\);/);
});

test("App mounts the window provider around the page; the twin's open message is checked like twin:selected", () => {
  assert.match(app, /<LabWindowProvider devices=\{devices\}/);
  assert.match(app, /apiRef=\{labWindowRef\}/);
  assert.match(app, /<WindowBackdrop>/);
  const listener = slice("    const onTwinOpen = event => {", "    window.addEventListener(\"message\", onTwinOpen);");
  assert.match(listener, /event\.origin !== location\.origin \|\| !frame \|\| event\.source !== frame\.contentWindow/);
  assert.match(listener, /twinOpenRequest\(event\.data\)/);
  // Inventory is the Manage page (a stub over today's table until WP-M).
  assert.match(app, /mainTab === "inventory" && \(\n\s*<ManageView /);
  assert.doesNotMatch(app, /\["racks", "inventory", "power", "changelog"\]/);
  assert.match(read("../pages/ManageView.jsx"), /<DcimView \{\.\.\.props\} section="inventory"\/>/);
});
