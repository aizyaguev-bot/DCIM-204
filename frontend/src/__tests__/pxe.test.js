import test from "node:test";
import assert from "node:assert/strict";
import {
  STEPS, stepIndex, menuPhase, isTerminal, stateLabel, canFlags, asList, normalizeOptions, choiceKind,
  rebootMethods, formatCountdown, isExpired, parseConsoleUrl, highlightSegments, errorText, screenshotUrl,
  toMillis, formatWhen, isSimulated, takeoverConsole, shortId,
} from "../api/pxe.js";

test("states map onto the five progress steps", () => {
  assert.equal(STEPS.length, 5);
  assert.equal(stepIndex("draft"), -1);
  assert.equal(stepIndex("rebooting"), 0);
  assert.equal(stepIndex("waiting_for_menu"), 1);
  assert.equal(stepIndex("waiting_for_grub"), 1);
  assert.equal(stepIndex("waiting_for_choice"), 2);
  assert.equal(stepIndex("waiting_for_grub_choice"), 2);
  assert.equal(stepIndex("updating_urls"), 3);
  assert.equal(stepIndex("ready_to_install"), 3);
  assert.equal(stepIndex("installing"), 4);
  assert.equal(stepIndex("install_started"), 4);
  assert.equal(stepIndex("completed"), 5);
});

test("a failed job points at its failed step, unknown states at nothing", () => {
  assert.equal(stepIndex("failed", "waiting_for_grub"), 1);
  assert.equal(stepIndex("failed", "install_started"), 4);
  assert.equal(stepIndex("failed", "draft"), 0);
  assert.equal(stepIndex("failed"), null);
  assert.equal(stepIndex("manual_takeover", "bogus"), null);
  assert.equal(stepIndex(undefined), null);
});

test("menu phase distinguishes the BIOS boot menu from GRUB", () => {
  assert.equal(menuPhase("waiting_for_menu"), "boot");
  assert.equal(menuPhase("waiting_for_choice"), "boot");
  assert.equal(menuPhase("waiting_for_grub_choice"), "grub");
  assert.equal(menuPhase("rebooting"), null);
  assert.equal(choiceKind("waiting_for_choice"), "boot");
  assert.equal(choiceKind("waiting_for_grub_choice"), "grub");
  assert.equal(choiceKind("waiting_for_grub"), null);
});

test("terminal states stop polling; install_started is not completed", () => {
  for (const s of ["completed", "failed", "cancelled", "manual_takeover"]) assert.equal(isTerminal(s), true);
  for (const s of ["draft", "rebooting", "ready_to_install", "installing", "install_started"]) assert.equal(isTerminal(s), false);
});

test("the API state label wins over the local fallback", () => {
  assert.equal(stateLabel({ state: "rebooting", state_label: "מאתחל (API)" }), "מאתחל (API)");
  assert.equal(stateLabel({ state: "rebooting" }), "מאתחל");
  assert.equal(stateLabel("install_started"), "מתקין");
  assert.equal(stateLabel({ state: "new_state" }), "new_state");
});

test("can-flags are strict booleans with false defaults", () => {
  const can = canFlags({ can: { install: true, cancel: "yes", takeover: 1 } });
  assert.equal(can.install, true);
  assert.equal(can.cancel, false);
  assert.equal(can.takeover, false);
  assert.equal(can.complete, false);
  assert.deepEqual(Object.values(canFlags(null)).filter(Boolean), []);
});

test("refreshing the screenshot is offered only while the job has a console session", () => {
  assert.equal(canFlags({ state: "rebooting", can: { refresh_screenshot: true } }).refresh_screenshot, true);
  assert.equal(canFlags({ state: "completed", can: { refresh_screenshot: false } }).refresh_screenshot, false);
  assert.equal(canFlags({ state: "draft", can: {} }).refresh_screenshot, false);
});

test("list responses may be bare arrays or wrapped", () => {
  assert.deepEqual(asList([1, 2], "jobs"), [1, 2]);
  assert.deepEqual(asList({ jobs: [3] }, "jobs"), [3]);
  assert.deepEqual(asList({ other: [3] }, "jobs"), []);
  assert.deepEqual(asList(null, "jobs"), []);
});

test("screen options normalize objects and strings and mark the highlight", () => {
  assert.deepEqual(normalizeOptions([{ id: "a", label: "UEFI: IPv4", highlighted: true, recommended: true }, { id: "b", text: "BIOS Setup", selectable: false }]), [
    { id: "a", label: "UEFI: IPv4", highlighted: true, selectable: true, recommended: true },
    { id: "b", label: "BIOS Setup", highlighted: false, selectable: false, recommended: false },
  ]);
  assert.deepEqual(normalizeOptions(["x", "y"], 1), [
    { id: 0, label: "x", highlighted: false, selectable: true, recommended: false },
    { id: 1, label: "y", highlighted: true, selectable: true, recommended: false },
  ]);
  assert.deepEqual(normalizeOptions(undefined), []);
});

test("reboot methods get readable labels; PDU says it cuts power", () => {
  const methods = rebootMethods({ reboot_methods: ["manual", "kvm_cad", "pdu_cycle"] });
  assert.deepEqual(methods.map(m => m.id), ["manual", "kvm_cad", "pdu_cycle"]);
  assert.match(methods[2].label, /cuts power/);
  assert.deepEqual(rebootMethods({ reboot_methods: [{ id: "manual", label: "Manual" }] }), [{ id: "manual", label: "Manual" }]);
  assert.deepEqual(rebootMethods({}).map(m => m.id), ["manual"]);
});

test("countdown formats minutes and hours and never goes negative", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  assert.equal(formatCountdown("2026-10-13T12:02:05Z", now), "2:05");
  assert.equal(formatCountdown("2026-10-13T16:00:09Z", now), "4:00:09");
  assert.equal(formatCountdown("2026-10-13T11:00:00Z", now), "0:00");
  assert.equal(formatCountdown(null, now), null);
  assert.equal(formatCountdown("garbage", now), null);
  assert.equal(isExpired("2026-10-13T11:59:59Z", now), true);
  assert.equal(isExpired("2026-10-13T12:00:01Z", now), false);
  assert.equal(isExpired(null, now), false);
});

test("API timestamps in Unix seconds are converted to milliseconds", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const sec = now / 1000;
  assert.equal(toMillis(sec), now);
  assert.equal(toMillis(sec + 0.5), now + 500);
  assert.equal(toMillis(String(sec)), now);
  assert.equal(toMillis(now), now);
  assert.equal(toMillis("2026-10-13T12:00:00Z"), now);
  assert.ok(Number.isNaN(toMillis(null)));
  assert.ok(Number.isNaN(toMillis("")));
  assert.equal(formatCountdown(sec + 125, now), "2:05");
  assert.equal(formatCountdown(sec + 4 * 3600 + 9, now), "4:00:09");
  assert.equal(formatCountdown(sec - 10, now), "0:00");
  assert.equal(isExpired(sec + 125, now), false);
  assert.equal(isExpired(sec - 1, now), true);
  assert.equal(formatWhen(sec), formatWhen(now));
  assert.equal(formatWhen(sec), formatWhen("2026-10-13T12:00:00Z"));
  assert.match(formatWhen(sec), /13/);
  assert.equal(formatWhen(null), "—");
});

test("a simulated job never opens a real KVM console after takeover", () => {
  const sim = { driver: "simulated", kvm_device_id: 3, kvm_port: 9 };
  assert.equal(isSimulated(sim), true);
  assert.deepEqual(takeoverConsole(sim, { console_url: null, simulated: true }), { simulated: true, port: 9 });
  assert.deepEqual(takeoverConsole(sim, { console_url: "/api/kvms/3/autologin?port=9" }), { simulated: true, port: 9 });
  assert.deepEqual(takeoverConsole(sim), { simulated: true, port: 9 });
  assert.deepEqual(takeoverConsole({ kvm_device_id: 3, kvm_port: 9 }, { console_url: null, simulated: true }), { simulated: true, port: 9 });
  assert.deepEqual(takeoverConsole({}, { console_url: null, job: { driver: "simulated", kvm_port: 4 } }), { simulated: true, port: 4 });
});

test("a real job opens the console from the takeover URL, else from its KVM port", () => {
  const real = { driver: "raritan", kvm_device_id: 3, kvm_port: 9 };
  assert.equal(isSimulated(real), false);
  assert.deepEqual(takeoverConsole(real, { console_url: "/api/kvms/5/autologin?port=2" }), { open: { deviceId: "5", port: 2 } });
  assert.deepEqual(takeoverConsole(real, { console_url: "https://evil.example/x" }), { open: { deviceId: 3, port: 9 } });
  assert.deepEqual(takeoverConsole(real), { open: { deviceId: 3, port: 9 } });
  assert.deepEqual(takeoverConsole({ driver: "raritan" }, { console_url: null }), { missing: true });
});

test("console URLs are accepted only in the KVM autologin form", () => {
  assert.deepEqual(parseConsoleUrl("/api/kvms/kvm-1/autologin?port=7"), { deviceId: "kvm-1", port: 7 });
  assert.deepEqual(parseConsoleUrl("/api/kvms/a%20b/autologin?port=12"), { deviceId: "a b", port: 12 });
  assert.equal(parseConsoleUrl("https://evil.example/api/kvms/1/autologin?port=1"), null);
  assert.equal(parseConsoleUrl("/api/kvms/1/autologin?port=1&x=2"), null);
  assert.equal(parseConsoleUrl(null), null);
});

const BEFORE = "linuxefi /images/r9/vmlinuz ip=dhcp inst.repo=http://webrepo/r9 inst.ks=http://webrepo/r9.cfg POSTFILE=webrepo quiet";
const AFTER = "linuxefi /images/r9/vmlinuz ip=dhcp inst.repo=http://192.168.136.101/r9 inst.ks=http://192.168.136.101/r9.cfg POSTFILE=webrepo quiet";
const HOST = "192.168.136.101";
const repoAt = BEFORE.indexOf("webrepo/r9 ");
const ksAt = BEFORE.indexOf("webrepo/r9.cfg");
const CHANGES = [
  { key: "inst.ks", start: ksAt, end: ksAt + 7, before: "webrepo", after: HOST },
  { key: "inst.repo", start: repoAt, end: repoAt + 7, before: "webrepo", after: HOST },
];

test("before/after highlight only the host spans and keep every byte", () => {
  for (const [text, side, needle] of [[BEFORE, "before", "webrepo"], [AFTER, "after", HOST]]) {
    const segs = highlightSegments(text, CHANGES, side);
    assert.equal(segs.map(s => s.text).join(""), text);
    const changed = segs.filter(s => s.changed);
    assert.deepEqual(changed.map(s => s.text), [needle, needle]);
    assert.deepEqual(changed.map(s => s.key), ["inst.repo", "inst.ks"]);
  }
  const plain = highlightSegments(BEFORE, CHANGES, "before").filter(s => !s.changed).map(s => s.text).join("");
  assert.match(plain, /POSTFILE=webrepo/);
});

test("highlighting falls back to searching after the key when offsets do not match", () => {
  const segs = highlightSegments(AFTER, [{ key: "inst.ks", start: 999, before: "webrepo", after: HOST }], "after");
  assert.equal(segs.map(s => s.text).join(""), AFTER);
  const changed = segs.filter(s => s.changed);
  assert.equal(changed.length, 1);
  assert.equal(AFTER.indexOf(HOST, AFTER.indexOf("inst.ks=")), segs.slice(0, segs.indexOf(changed[0])).map(s => s.text).join("").length);
  assert.deepEqual(highlightSegments("", [], "before"), [{ text: "", changed: false }]);
  assert.deepEqual(highlightSegments("abc", null, "after"), [{ text: "abc", changed: false }]);
});

test("errors prefer the server detail verbatim", () => {
  assert.equal(errorText({ status: 503, detail: "Playwright is not installed" }), "Playwright is not installed");
  assert.equal(errorText({ status: 429 }), "Too many attempts. Wait a few minutes and try again.");
  assert.equal(errorText({ status: 418 }), "Request failed (HTTP 418).");
  assert.match(errorText(new Error("x")), /connection/);
});

test("job ids are shortened to 8 characters for display", () => {
  assert.equal(shortId("f00dfeed12345678abcdef0123456789"), "f00dfeed");
  assert.equal(shortId(42), "42");
  assert.equal(shortId(null), "");
});

test("screenshot URL is cache-busted by sequence", () => {
  assert.equal(screenshotUrl(5, 3), "/api/pxe/jobs/5/screenshot?seq=3");
  assert.equal(screenshotUrl("a/b", undefined), "/api/pxe/jobs/a%2Fb/screenshot?seq=0");
});
