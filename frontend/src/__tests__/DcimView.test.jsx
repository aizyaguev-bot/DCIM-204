import { render, screen, fireEvent } from "@testing-library/react";
import DcimView, { isDefaultOutletLabel } from "../pages/DcimView";

// ─── isDefaultOutletLabel unit tests ─────────────────────────────────────────
describe("isDefaultOutletLabel", () => {
  it("returns true for null / empty string", () => {
    expect(isDefaultOutletLabel(null)).toBe(true);
    expect(isDefaultOutletLabel("")).toBe(true);
    expect(isDefaultOutletLabel("   ")).toBe(true);
  });

  it("returns true for generic 'Outlet N' labels", () => {
    expect(isDefaultOutletLabel("Outlet 1")).toBe(true);
    expect(isDefaultOutletLabel("outlet 20")).toBe(true);
    expect(isDefaultOutletLabel("OUTLET 3")).toBe(true);
  });

  it("returns true for generic 'Port N' labels", () => {
    expect(isDefaultOutletLabel("Port 1")).toBe(true);
    expect(isDefaultOutletLabel("port 8")).toBe(true);
  });

  it("returns false for real server names", () => {
    expect(isDefaultOutletLabel("Opt106")).toBe(false);
    expect(isDefaultOutletLabel("Server-A")).toBe(false);
    expect(isDefaultOutletLabel("Optn88")).toBe(false);
  });
});

// ─── test data ────────────────────────────────────────────────────────────────
// labels = stored outlet/port names (from backend labels_json, now included in DeviceOut)
const devices = [
  {
    id: 1, kind: "pdu", name: "PDU-Rack01", ip: "10.7.30.1", rack: "Rack-01",
    labels: { "1": "Server-A", "2": "Server-B", "4": "server-c" },
    // note: outlet 3 has no stored label → won't appear
  },
  {
    id: 2, kind: "pdu", name: "PDU-Rack02", ip: "10.7.30.2", rack: "Rack-02",
    labels: { "1": "Server-D" },
  },
  {
    id: 3, kind: "kvm", name: "KVM-01", ip: "10.7.30.10", rack: "Rack-01",
    labels: { "1": "Server-A", "2": "Server-B" },
  },
];

// pduStatuses enriches stored labels with live power data
const pduStatuses = {
  1: {
    reachable: true,
    total_watts: 450,
    outlets: [
      { number: 1, label: "Server-A",  state: "on",  watts: 250 },
      { number: 2, label: "Server-B",  state: "off", watts: 0   },
      { number: 3, label: "Outlet 3",  state: "off", watts: 0   }, // default label — skipped
      { number: 4, label: "server-c",  state: "on",  watts: 200 },
    ],
  },
  2: {
    reachable: true,
    total_watts: 800,
    outlets: [
      { number: 1, label: "Server-D",  state: "on",  watts: 800 },
      { number: 2, label: "Outlet 2",  state: "off", watts: 0   }, // default label — skipped
    ],
  },
};

const kvmStatuses = {
  3: {
    ports: [
      { number: 1, label: "Server-A", status: "idle"   },
      { number: 2, label: "Server-B", status: "active" },
      { number: 3, label: "No-PDU",   status: "idle"   }, // no PDU match → not added
    ],
  },
};

function renderDcim(overrides = {}) {
  return render(
    <DcimView
      devices={devices}
      pduStatuses={pduStatuses}
      kvmStatuses={kvmStatuses}
      {...overrides}
    />
  );
}

// ─── DcimView integration tests ───────────────────────────────────────────────
describe("DcimView — stored labels (OPTs visible without live PDU data)", () => {
  it("shows OPTs from device.labels even when pduStatuses is empty", () => {
    render(
      <DcimView
        devices={devices}
        pduStatuses={{}}    // PDU offline / not yet polled
        kvmStatuses={{}}
      />
    );
    // Switch to Inventory to see the asset list
    fireEvent.click(screen.getByRole("button", { name: /inventory/i }));
    // OPTs come from device.labels, so they must appear regardless of PDU status
    expect(screen.getByText("Server-A")).toBeInTheDocument();
    expect(screen.getByText("Server-B")).toBeInTheDocument();
    expect(screen.getByText("Server-D")).toBeInTheDocument();
  });

  it("shows 'unknown' state when PDU hasn't responded yet", () => {
    render(
      <DcimView devices={devices} pduStatuses={{}} kvmStatuses={{}} />
    );
    fireEvent.click(screen.getByRole("button", { name: /inventory/i }));
    const unknownPills = screen.getAllByText("unknown");
    expect(unknownPills.length).toBeGreaterThanOrEqual(1);
  });

  it("enriches state with live data once PDU responds", () => {
    render(
      <DcimView devices={devices} pduStatuses={pduStatuses} kvmStatuses={{}} />
    );
    fireEvent.click(screen.getByRole("button", { name: /inventory/i }));
    // Server-A is "on" in live data
    expect(screen.getAllByText("on").length).toBeGreaterThanOrEqual(1);
    // Server-B is "off" in live data
    expect(screen.getAllByText("off").length).toBeGreaterThanOrEqual(1);
  });
});

describe("DcimView — Racks sub-view", () => {
  it("renders rack cards for each discovered rack", () => {
    renderDcim();
    expect(screen.getByText("Rack-01")).toBeInTheDocument();
    expect(screen.getByText("Rack-02")).toBeInTheDocument();
  });

  it("shows rack-level power draw from PDU status", () => {
    renderDcim();
    // Rack-01 PDU = 450 W — appears once in rack header (Server-A=250W, server-c=200W)
    expect(screen.getAllByText("450 W").length).toBeGreaterThanOrEqual(1);
    // Rack-02 PDU = 800 W — appears in rack header AND in Server-D slot
    expect(screen.getAllByText("800 W").length).toBeGreaterThanOrEqual(1);
  });

  it("shows OPT count in rack header subtitle", () => {
    renderDcim();
    // Text is split across JSX nodes → use element.textContent
    const subtitles = document.querySelectorAll(".text-\\[9px\\]");
    const texts = Array.from(subtitles).map(el => el.textContent);
    expect(texts.some(t => t.includes("3 OPTs"))).toBe(true);
    expect(texts.some(t => t.includes("1 OPT"))).toBe(true);
  });

  it("renders a ServerSlot for each OPT in the rack", () => {
    renderDcim();
    // All named OPTs from Rack-01 and Rack-02 should appear as server slots
    expect(screen.getByText("Server-A")).toBeInTheDocument();
    expect(screen.getByText("Server-B")).toBeInTheDocument();
    expect(screen.getByText("Server-D")).toBeInTheDocument();
  });

  it("renders empty state when no devices are provided", () => {
    renderDcim({ devices: [], pduStatuses: {}, kvmStatuses: {} });
    expect(screen.getByText(/no racks discovered/i)).toBeInTheDocument();
  });
});

describe("DcimView — sub-tab navigation", () => {
  it("starts on the Racks tab by default", () => {
    renderDcim();
    expect(screen.getByRole("button", { name: /racks/i })).toBeInTheDocument();
    // Racks content visible: rack names
    expect(screen.getByText("Rack-01")).toBeInTheDocument();
  });

  it("switches to Inventory tab and shows server table", () => {
    renderDcim();
    fireEvent.click(screen.getByRole("button", { name: /inventory/i }));
    // Column headers
    expect(screen.getByText("Asset name")).toBeInTheDocument();
    expect(screen.getByText("Rack")).toBeInTheDocument();
    expect(screen.getByText("State")).toBeInTheDocument();
  });

  it("switches to Power tab and shows power section", () => {
    renderDcim();
    fireEvent.click(screen.getByRole("button", { name: /power/i }));
    expect(screen.getByText("Power consumption per rack")).toBeInTheDocument();
  });
});

describe("DcimView — Inventory sub-view", () => {
  beforeEach(() => {
    renderDcim();
    fireEvent.click(screen.getByRole("button", { name: /inventory/i }));
  });

  it("auto-detects server assets from PDU outlet labels", () => {
    expect(screen.getByText("Server-A")).toBeInTheDocument();
    expect(screen.getByText("Server-B")).toBeInTheDocument();
    expect(screen.getByText("Server-D")).toBeInTheDocument();
  });

  it("skips default outlet labels like 'Outlet 3'", () => {
    expect(screen.queryByText("Outlet 3")).not.toBeInTheDocument();
    expect(screen.queryByText("Outlet 2")).not.toBeInTheDocument();
  });

  it("cross-references KVM port labels to add console port info", () => {
    // Both Server-A and Server-B map to KVM-01, so "KVM-01" should appear at least twice
    const kvmCells = screen.getAllByText("KVM-01");
    expect(kvmCells.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT add KVM-only assets that have no PDU outlet", () => {
    // "No-PDU" is only in KVM ports, not in any PDU outlet
    expect(screen.queryByText("No-PDU")).not.toBeInTheDocument();
  });

  it("shows power state pills", () => {
    // 'on' and 'off' pills should appear
    const onPills = screen.getAllByText("on");
    expect(onPills.length).toBeGreaterThanOrEqual(1);
    const offPills = screen.getAllByText("off");
    expect(offPills.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by rack", () => {
    const select = screen.getAllByRole("combobox")[0];
    fireEvent.change(select, { target: { value: "Rack-02" } });
    expect(screen.getByText("Server-D")).toBeInTheDocument();
    expect(screen.queryByText("Server-A")).not.toBeInTheDocument();
  });

  it("filters by power state", () => {
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "on" } });
    expect(screen.getByText("Server-A")).toBeInTheDocument();
    expect(screen.queryByText("Server-B")).not.toBeInTheDocument();
  });

  it("filters by search text", () => {
    const input = screen.getByPlaceholderText(/search assets/i);
    fireEvent.change(input, { target: { value: "server-d" } });
    expect(screen.getByText("Server-D")).toBeInTheDocument();
    expect(screen.queryByText("Server-A")).not.toBeInTheDocument();
  });
});

describe("DcimView — Power sub-view", () => {
  beforeEach(() => {
    renderDcim();
    fireEvent.click(screen.getByRole("button", { name: /power/i }));
  });

  it("shows total draw summary tile", () => {
    // 450 + 800 = 1250 W
    expect(screen.getByText("1250 W")).toBeInTheDocument();
  });

  it("shows Racks stat tile in power view", () => {
    // StatTile sub-label is unique to the Racks tile
    expect(screen.getByText("with power data")).toBeInTheDocument();
  });

  it("renders per-rack bar chart section", () => {
    expect(screen.getByText("Power consumption per rack")).toBeInTheDocument();
  });

  it("shows top power consumers list when wattage data exists", () => {
    expect(screen.getByText("Top power consumers")).toBeInTheDocument();
    // Server-D at 800 W should be the top consumer
    expect(screen.getByText("Server-D")).toBeInTheDocument();
  });
});
