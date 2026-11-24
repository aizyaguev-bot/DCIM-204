import test from "node:test";
import assert from "node:assert/strict";
import { maskRemovedLabels, withoutRemovedDevice, withoutRemovedStatus, withoutRemovedStatuses } from "../api/removedServers.js";

const hidden = new Set(["optn144"]);

test("a removed server's name on a saved label reads as the default (empty) label; others stay", () => {
  const labels = { "1": "OPT11", "22": "optn144", "23": "OPTN144 (PSU2)", "24": "optn1440" };
  assert.deepEqual(maskRemovedLabels(labels, hidden), { "1": "OPT11", "22": "", "23": "", "24": "optn1440" });
  assert.equal(maskRemovedLabels(labels, new Set()), labels, "nothing hidden: same object");
  const clean = { "1": "OPT11" };
  assert.equal(maskRemovedLabels(clean, hidden), clean, "nothing masked: same object");
});

test("device and status readings: outlets read 'Outlet N', KVM ports read 'Port N'", () => {
  const device = { id: "pdu5", labels: { "22": "optn144" } };
  assert.deepEqual(withoutRemovedDevice(device, hidden).labels, { "22": "" });
  const pdu = { reachable: true, outlets: [{ number: 22, label: "optn144", state: "on" }, { number: 1, label: "OPT51", state: "on" }] };
  const shown = withoutRemovedStatus(pdu, hidden);
  assert.deepEqual(shown.outlets.map(o => o.label), ["Outlet 22", "OPT51"]);
  assert.equal(shown.outlets[0].state, "on", "power state is kept");
  const kvm = { ports: [{ number: 8, label: "Optn144", in_use: false }] };
  assert.equal(withoutRemovedStatus(kvm, hidden).ports[0].label, "Port 8");
  const all = { pdu5: pdu, kvm3: kvm, other: { outlets: [{ number: 1, label: "OPT1" }] } };
  const masked = withoutRemovedStatuses(all, hidden);
  assert.equal(masked.other, all.other, "untouched status: same object");
  assert.equal(withoutRemovedStatuses(all, new Set()), all);
});
