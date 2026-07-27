// Real lab device data — auto-generated from device list provided 2026-05-12.
// Edit freely. To reset to this state: localStorage.clear() then reload.
//
// NOTE: Rack 06 PDU (10.7.30.201) has TWO devices listed at Port 23 (Opt41 + Optn87).
// That is physically impossible on one PDU. Optn87 is flagged with ⚠ until you confirm
// the correct port number.

window.MOCK_DATA = {
  racks: ["Rack-01", "Rack-02", "Rack-03", "Rack-04", "Rack-05", "Rack-06"],

  pdus: [
    {
      id: "pdu-rack01",
      name: "PDU-Rack-01",
      model: "Raritan PDU",
      ip: "10.7.30.137",
      rack: "Rack-01",
      status: "online",
      firmware: "—",
      inletVoltage: 208,
      outlets: buildOutlets(24, {
        13: "Opt133",
        21: "Opt183",
        23: "Opt207",
        24: "Optn85 (SSD)",
      }),
    },
    {
      id: "pdu-rack02",
      name: "PDU-Rack-02",
      model: "Raritan PDU",
      ip: "10.7.30.136",
      rack: "Rack-02",
      status: "online",
      firmware: "—",
      inletVoltage: 208,
      outlets: buildOutlets(24, {
        6:  "Optn130",
        13: "Opt208",
        20: "Optn84",
        22: "Optn84 (2)",
      }),
    },
    {
      id: "pdu-rack03",
      name: "PDU-Rack-03",
      model: "Raritan PDU",
      ip: "10.7.30.129",
      rack: "Rack-03",
      status: "online",
      firmware: "—",
      inletVoltage: 208,
      outlets: buildOutlets(24, {
        9:  "Opt106",
        17: "Optn36",
        20: "Optn88",
        23: "Optn51",
      }),
    },
    {
      id: "pdu-rack04",
      name: "PDU-Rack-04",
      model: "Raritan PDU",
      ip: "10.7.30.93",
      rack: "Rack-04",
      status: "online",
      firmware: "—",
      inletVoltage: 208,
      outlets: buildOutlets(24, {
        9:  "Opt60",
        18: "Opt94",
        19: "Optn144",
        23: "Opt (unlabeled)",
      }),
    },
    {
      id: "pdu-rack05",
      name: "PDU-Rack-05",
      model: "Raritan PDU",
      ip: "10.7.30.141",
      rack: "Rack-05",
      status: "online",
      firmware: "—",
      inletVoltage: 208,
      outlets: buildOutlets(24, {
        13: "Optn45",
        22: "Opt (unlabeled)",
        23: "Optn108",
      }),
    },
    {
      id: "pdu-rack06",
      name: "PDU-Rack-06",
      model: "Raritan PDU",
      ip: "10.7.30.201",
      rack: "Rack-06",
      status: "online",
      firmware: "—",
      inletVoltage: 208,
      outlets: buildOutlets(24, {
        13: "Optn93",
        17: "Opt250",
        20: "Optn114",
        22: "Optn101",
        23: "Opt41",
      }),
    },
  ],

  kvms: [
    {
      id: "kvm-unit1",
      name: "KVM-Unit-1",
      model: "Raritan Dominion KX III",
      shortModel: "KX III",
      ip: "10.7.30.49",
      rack: "Rack-01",
      status: "online",
      firmware: "—",
      portCount: 16,
      ports: buildPorts([
        "Opt106",    // port 1
        "Optn88",    // port 2
        "Opt94",     // port 3
        "Opt133",    // port 4
        "Opt60",     // port 5
        "Optn51",    // port 6
        "Optn144",   // port 7
        "Opt208",    // port 8
        "Optn130",   // port 9
        "Optn84",    // port 10
        "Opt133 (2)",// port 11
        "Optn85",    // port 12
        "Optn84 (2)",// port 13
        "Optn36",    // port 14
        "Optn183",   // port 15
        "Opt207",    // port 16
      ]),
    },
    {
      id: "kvm-unit2",
      name: "KVM-Unit-2",
      model: "Raritan Dominion KX III",
      shortModel: "KX III",
      ip: "10.7.30.115",
      rack: "Rack-06",
      status: "online",
      firmware: "—",
      portCount: 8,
      ports: buildPorts([
        "Opt250",    // port 1
        "Optn93",    // port 2
        "Optn87",    // port 3
        "Optn114",   // port 4
        "Opt41",     // port 5
        "Optn101",   // port 6
        null,        // port 7 — empty
        null,        // port 8 — empty
      ]),
    },
    {
      id: "kvm-unit3",
      name: "KVM-Unit-3",
      model: "Raritan Dominion LX II",
      shortModel: "LX II",
      ip: "10.7.30.53",
      rack: "Rack-05",
      status: "online",
      firmware: "—",
      portCount: 8,
      notes: "LX II unit — live iframe embed may fall back to native viewer in a new tab.",
      ports: buildPorts([
        "Optn149",   // port 1
        "Optn108",   // port 2
        "Optn45",    // port 3
        null,        // port 4 — empty
        null,        // port 5 — empty
        null,        // port 6 — empty
        null,        // port 7 — empty
        null,        // port 8 — empty
      ]),
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a full outlet array for a PDU.
// namedMap: { outletNumber: "label" } for assigned outlets.
// All other outlets are created as empty/off.
function buildOutlets(count, namedMap) {
  const result = [];
  for (let i = 1; i <= count; i++) {
    const label = namedMap[i];
    const assigned = !!label;
    result.push({
      id: `o${i}`,
      number: i,
      label: label || `Outlet ${i}`,
      state: assigned ? "on" : "off",
      watts: assigned ? (180 + Math.floor(Math.random() * 300)) : 0,
      current: 0,
      severity: label && label.startsWith("⚠") ? "warning" : (assigned ? "ok" : "off"),
    });
  }
  // Fix current values
  result.forEach(o => { o.current = o.watts ? +(o.watts / 208).toFixed(2) : 0; });
  return result;
}

// Build a port array for a KVM.
// labels: array of string labels (or null for empty), index 0 = port 1.
function buildPorts(labels) {
  return labels.map((label, i) => ({
    id: `p${i + 1}`,
    number: i + 1,
    label: label || `Port ${i + 1}`,
    status: label ? "active" : "empty",
    screenType: label ? "linux-term" : "blank",
  }));
}
