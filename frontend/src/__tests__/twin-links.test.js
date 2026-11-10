import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { optKey, serverRef, itemRef, rackRef, isTwinRef, twinSrc, linkedTwinRef, twinSelectMessage, twinRefToReplay, TWIN_PATH, TWIN_HIDDEN_KEEP_MS } from "../twinLinks.js";

// "Show in 3D": the refs and URL Lab Manager hands to the embedded twin (the shared interface with lab-twin/app.js).
const read = rel => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../App.jsx");
const dcim = read("../pages/DcimView.jsx");
function slice(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `source contains ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `source contains ${end} after ${start}`);
  return source.slice(from, to);
}
const fn = (names, source, result) => new Function(...names, `${source}\nreturn ${result};`);

test("optKey is the twin's own optKey (lab-twin/app.js)", () => {
  const twin = read("../../../lab-twin/app.js");
  const body = /const optKey = (s => [^;\n]+);/.exec(twin)?.[1];
  assert.ok(body, "lab-twin/app.js defines optKey");
  const twinKey = new Function(`return (${body});`)();
  for (const label of ["OPT12", "  OPT12  ", "opt12", "Opt 12", " OPT12 (A) ", "Straße-01", "", null, undefined, "\tOPTN7\n"]) {
    assert.equal(optKey(label), twinKey(label), JSON.stringify(label));
  }
  assert.equal(optKey("  OPT12 "), "opt12");
  assert.equal(optKey("OPT 12"), "opt 12", "inner spaces stay, as in the twin");
});

test("refs: srv:<optKey>, item:<rack item id>, rack:<rack name>", () => {
  assert.equal(serverRef(" OPT12 "), "srv:opt12");
  assert.equal(serverRef("OPT31"), "srv:opt31");
  assert.equal(serverRef("   "), null);
  assert.equal(serverRef(null), null);
  assert.equal(itemRef("ci-3"), "item:ci-3");
  assert.equal(itemRef(""), null);
  assert.equal(itemRef(undefined), null);
  assert.equal(rackRef("Rack-03"), "rack:Rack-03");
  assert.equal(rackRef("Storage shelf"), "rack:Storage shelf");
  assert.equal(rackRef(""), null);
  for (const ref of ["srv:opt12", "item:ci-3", "rack:Rack-03", "rack:Storage shelf"]) assert.ok(isTwinRef(ref), ref);
  for (const ref of ["", "opt12", "srv:", "box:1", "rack: x", null, 3]) assert.equal(isTwinRef(ref), false, String(ref));
});

test("the twin URL carries the encoded ref; no ref keeps the plain embed URL", () => {
  assert.equal(TWIN_PATH, "/twin/index.html");
  assert.equal(twinSrc(null), "/twin/index.html?embed=1");
  assert.equal(twinSrc("nonsense"), "/twin/index.html?embed=1");
  assert.equal(twinSrc("rack:Rack-03"), "/twin/index.html?embed=1&select=rack%3ARack-03");
  assert.equal(twinSrc("srv:opt 1&x=2"), "/twin/index.html?embed=1&select=srv%3Aopt%201%26x%3D2");
  assert.equal(new URL(twinSrc("item:ci-a/b#c"), "https://lab.test").searchParams.get("select"), "item:ci-a/b#c");
  assert.equal(linkedTwinRef("?tab=twin&select=srv%3Aopt12"), "srv:opt12");
  assert.equal(linkedTwinRef("?tab=twin&select=srv:opt12"), "srv:opt12");
  assert.equal(linkedTwinRef("?tab=racks&select=srv:opt12"), null, "only on the Twin tab");
  assert.equal(linkedTwinRef("?tab=twin&select=junk"), null);
  assert.equal(linkedTwinRef("?tab=twin"), null);
  assert.deepEqual(twinSelectMessage("rack:Rack-03"), { type: "twin:select", ref: "rack:Rack-03" });
});

test("Back / Forward replays the address's ref only when the twin was last given another one", () => {
  assert.equal(twinRefToReplay("?tab=twin&select=rack%3ARack-03", "srv:opt31"), "rack:Rack-03");
  assert.equal(twinRefToReplay("?tab=twin&select=rack%3ARack-03", null), "rack:Rack-03");
  assert.equal(twinRefToReplay("?tab=twin&select=rack%3ARack-03", "rack:Rack-03"), null, "the twin has it already");
  assert.equal(twinRefToReplay("?tab=twin", "srv:opt31"), null, "the Twin tab button's address: the twin stays as it is");
  assert.equal(twinRefToReplay("?tab=twin&select=junk", "srv:opt31"), null);
  assert.equal(twinRefToReplay("?tab=racks&select=srv%3Aopt12", null), null);
});

test("goTo('twin', { ref }) writes ?select= and shows the ref in the twin; other tabs keep goTo(tab, rack)", () => {
  const calls = { navigate: [], rack: [], twin: [] };
  const source = slice(app, "  // navigate() plus the rack", "  useEffect(() => {\n    const onPop");
  const twinFocusRef = { current: false };
  const { goTo } = fn(["window", "history", "setRackParam", "rackParam", "adminSection", "navigate", "navigateAdmin", "isTwinRef", "showInTwin", "twinFocusRef"], source, "{ goTo }")(
    {}, {}, value => calls.rack.push(value), null, "devices", (...args) => calls.navigate.push(args), () => {}, isTwinRef, ref => calls.twin.push(ref), twinFocusRef);
  goTo("twin");
  goTo("twin", { ref: "bogus" });
  assert.equal(twinFocusRef.current, false, "the Twin tab itself leaves focus on its tab button");
  goTo("twin", { ref: "rack:Rack-03" });
  assert.equal(twinFocusRef.current, true, "Show in 3D moves focus to the twin");
  goTo("racks", "Rack-03");
  goTo("racks", { rack: "Rack-04" });
  assert.deepEqual(calls.navigate, [["twin", undefined], ["twin", undefined], ["twin", undefined, "rack:Rack-03"], ["racks", "Rack-03"], ["racks", "Rack-04"]]);
  assert.deepEqual(calls.twin, ["rack:Rack-03"]);
  assert.deepEqual(calls.rack, [null, null, null, "Rack-03", "Rack-04"]);
  assert.match(app, /onShowIn3d=\{ref => goTo\("twin", \{ ref \}\)\}/);
});

test("navigate() sets ?select= only when given and drops it on every other navigation", () => {
  const run = (href, args) => {
    const pushed = [];
    const source = slice(app, "  function navigate(", "  function navigateAdmin(");
    const navigate = fn(["window", "history", "setView", "setMainTab", "setEditMode", "setAdminSection", "adminSection"], source, "navigate")(
      { location: { href } }, { pushState: (state, title, url) => pushed.push(String(url)) }, () => {}, () => {}, () => {}, () => {}, "devices");
    navigate(...args);
    return new URL(pushed[0]).searchParams;
  };
  let q = run("https://lab.test/?tab=racks&rack=Rack-03", ["twin", undefined, "srv:opt12"]);
  assert.deepEqual([q.get("tab"), q.has("rack"), q.get("select")], ["twin", false, "srv:opt12"]);
  q = run("https://lab.test/?tab=twin&select=srv%3Aopt12", ["racks", "Rack-03"]);
  assert.deepEqual([q.get("tab"), q.get("rack"), q.has("select")], ["racks", "Rack-03", false]);
  q = run("https://lab.test/?tab=twin&select=srv%3Aopt12", ["twin"]);
  assert.equal(q.has("select"), false, "the Twin tab button opens the twin as it is");
});

test("a loaded twin gets a message; one still loading gets ?select= in its src", () => {
  const harness = loaded => {
    const calls = { src: [], post: [] };
    const source = slice(app, "  function showInTwin(", "  function twinFrameLoaded(");
    const twinFrameRef = { current: loaded ? { contentWindow: {} } : null };
    const twinLoadedRef = { current: loaded };
    const twinRefRef = { current: "rack:Rack-03" };
    const showInTwin = fn(["twinLoadedRef", "twinFrameRef", "twinRefRef", "setTwinPost", "setTwinFrameSrc", "twinSrc"], source, "showInTwin")(
      twinLoadedRef, twinFrameRef, twinRefRef, value => calls.post.push(value), value => calls.src.push(value), twinSrc);
    showInTwin("item:ci-3");
    assert.equal(twinRefRef.current, "item:ci-3", "remembered as the twin's last ref");
    return calls;
  };
  assert.deepEqual(harness(true), { src: [], post: [{ ref: "item:ci-3" }] });
  assert.deepEqual(harness(false), { src: ["/twin/index.html?embed=1&select=item%3Aci-3"], post: [] });
  // the iframe is mounted while it has a src (hidden off the Twin tab for a while), posts only to its own origin,
  // and opens on ?tab=twin&select=
  assert.match(app, /\{twinFrameSrc && \(\n\s*<iframe ref=\{twinFrameRef\} title="3D Digital Twin" src=\{twinFrameSrc\} hidden=\{!twinShown\} onLoad=\{twinFrameLoaded\}/);
  assert.match(app, /postMessage\(twinSelectMessage\(twinPost\.ref\), location\.origin\)/);
  assert.match(app, /useState\(\(\) => \(new URLSearchParams\(location\.search\)\.get\("tab"\) === "twin" \? twinSrc\(linkedTwinRef\(location\.search\)\) : null\)\)/);
  assert.doesNotMatch(app, /postMessage\([^)]*["']\*["']\)/, "never to any origin");
});

test("the twin hidden for TWIN_HIDDEN_KEEP_MS is removed; showing it again first cancels that", () => {
  assert.equal(TWIN_HIDDEN_KEEP_MS, 20000);
  const source = slice(app, "  // Hidden for TWIN_HIDDEN_KEEP_MS", "  // After \"Show in 3D\": focus");
  const run = (twinShown, twinFrameSrc) => {
    const calls = { effect: null, timers: [], cleared: [], post: [], src: [] };
    const refs = { twinLoadedRef: { current: true }, twinRefRef: { current: "srv:opt31" } };
    fn(["useEffect", "setTimeout", "clearTimeout", "twinShown", "twinFrameSrc", "twinLoadedRef", "twinRefRef", "setTwinPost", "setTwinFrameSrc", "TWIN_HIDDEN_KEEP_MS"], source, "null")(
      effect => { calls.effect = effect; }, (cb, ms) => { calls.timers.push({ cb, ms }); return calls.timers.length; }, id => calls.cleared.push(id),
      twinShown, twinFrameSrc, refs.twinLoadedRef, refs.twinRefRef, v => calls.post.push(v), v => calls.src.push(v), TWIN_HIDDEN_KEEP_MS);
    const cleanup = calls.effect();
    return { calls, refs, cleanup };
  };
  assert.equal(run(true, "/twin/index.html?embed=1").calls.timers.length, 0, "on screen: kept");
  assert.equal(run(false, null).calls.timers.length, 0, "no twin: nothing to remove");
  const hidden = run(false, "/twin/index.html?embed=1");
  assert.equal(hidden.calls.timers.length, 1);
  assert.equal(hidden.calls.timers[0].ms, TWIN_HIDDEN_KEEP_MS);
  hidden.calls.timers[0].cb();
  assert.deepEqual([hidden.calls.src, hidden.calls.post, hidden.refs.twinLoadedRef.current, hidden.refs.twinRefRef.current], [[null], [null], false, null], "unmounted and forgotten");
  hidden.cleanup();
  assert.deepEqual(hidden.calls.cleared, [1], "showing it again (or a new src) clears the wait");
  // the next visit mounts it on the address's ?select=, and "Show in 3D" focuses it
  assert.match(app, /if \(!twinShown \|\| twinFrameSrc\) return;\n\s*const ref = linkedTwinRef\(location\.search\);\n\s*twinRefRef\.current = ref;\n\s*setTwinFrameSrc\(twinSrc\(ref\)\);/);
  assert.match(app, /twinFocusRef\.current = false;\n\s*twinFrameRef\.current\?\.focus\(\);/);
});

test("Back / Forward onto a Show in 3D address shows its ref in the twin again", () => {
  const source = slice(app, "    const onPop = event => {", "    window.addEventListener(\"popstate\", onPop);");
  const run = (search, state, last) => {
    const shown = [];
    const onPop = fn(["location", "linkedAdminSection", "mainTabRef", "setView", "setMainTab", "setAdminSection", "setEditMode", "twinRefToReplay", "twinRefRef", "showInTwin"], source, "onPop")(
      { search }, () => "devices", { current: "racks" }, () => {}, () => {}, () => {}, () => {}, twinRefToReplay, { current: last }, ref => shown.push(ref));
    onPop({ state });
    return shown;
  };
  const twin = { tab: "twin", view: { kind: "dashboard" } };
  assert.deepEqual(run("?tab=twin&select=rack%3ARack-03", twin, "srv:opt31"), ["rack:Rack-03"]);
  assert.deepEqual(run("?tab=twin&select=rack%3ARack-03", twin, "rack:Rack-03"), []);
  assert.deepEqual(run("?tab=twin", twin, "srv:opt31"), []);
  assert.deepEqual(run("?tab=racks&rack=Rack-03", { tab: "racks", view: { kind: "dashboard" } }, "srv:opt31"), []);
  assert.deepEqual(run("?tab=twin&select=rack%3ARack-03", { tab: "twin", view: { kind: "pdu", id: 1 } }, null), [], "a detail view over the twin tab");
});

test("DcimView offers Show in 3D on the rack card, the rack detail, the server dialog, the unit dialog and both edit panels", () => {
  assert.match(dcim, /\{!detail && <ShowIn3dButton target=\{rackRef\(r\.rack\)\} name=\{r\.rack\}\/>\}/);
  assert.match(dcim, /<ShowIn3dButton target=\{rackRef\(r\.rack\)\} name=\{r\.rack\} text className="racks-btn racks-btn-sm"\/>/);
  assert.match(dcim, /twinButton=\{<ShowIn3dButton target=\{serverRef\(selectedServer\.name\)\} name=\{selectedServer\.name\}\/>\}/);
  assert.match(read("../components/racks/ServerDetailsDialog.jsx"), /<span className="server-details-tools">\{sshSlot\}\{twinButton\}<button/);
  assert.match(dcim, /<ShowIn3dButton target=\{itemRef\(item\.id\)\} name=\{item\.name\} className=\{PANEL_ICON_BTN\}\/>/);
  assert.match(dcim, /const label = `Show \$\{name\} in 3D`;/);
  assert.match(dcim, /aria-label=\{label\}/);
  // the text button's visible words are its whole accessible name (WCAG 2.5.3 label in name)
  assert.match(dcim, /\{Icon\.cube\} Show <bdi>\{name\}<\/bdi> in 3D<\/button>/);
  assert.doesNotMatch(dcim, /Show<span className="sr-only">/);
  // Edit mode: the server and unit edit panels, blocked (aria-disabled, the reason on click) while unsaved
  assert.match(dcim, /<ShowIn3dButton target=\{serverRef\(server\.name\)\} name=\{server\.name\} className=\{PANEL_ICON_BTN\} blocked=\{twinBlocked\} onBlocked=\{twinBlockedClick\}\/>/);
  assert.match(dcim, /<ShowIn3dButton target=\{itemRef\(item\.id\)\} name=\{item\.name\} className=\{PANEL_ICON_BTN\} blocked=\{twinBlocked\} onBlocked=\{twinBlockedClick\}\/>/);
  assert.match(dcim, /"aria-disabled": blocked \? "true" : undefined/);
  assert.match(dcim, /if \(blocked\) onBlocked\?\.\(\); else showIn3d\(target\);/);
  assert.match(dcim, /<TwinLinkContext\.Provider value=\{onShowIn3d\}>/);
});
