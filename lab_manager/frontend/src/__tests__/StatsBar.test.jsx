import { render, screen } from "@testing-library/react";
import StatsBar from "../components/StatsBar";

const baseStats = {
  deviceCount: 4,
  outletsOn: 10,
  outletsTotal: 20,
  watts: 3500,
  portsActive: 3,
  portsTotal: 16,
  alerts: 0,
};

describe("StatsBar", () => {
  it("renders device count", () => {
    render(<StatsBar stats={baseStats} />);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Devices")).toBeInTheDocument();
  });

  it("renders outlets as fraction", () => {
    render(<StatsBar stats={baseStats} />);
    expect(screen.getByText("10 / 20")).toBeInTheDocument();
    expect(screen.getByText("Outlets on")).toBeInTheDocument();
  });

  it("converts watts to kW with two decimal places", () => {
    render(<StatsBar stats={baseStats} />);
    expect(screen.getByText("3.50 kW")).toBeInTheDocument();
    expect(screen.getByText("Total draw")).toBeInTheDocument();
  });

  it("renders KVM ports as fraction", () => {
    render(<StatsBar stats={baseStats} />);
    expect(screen.getByText("3 / 16")).toBeInTheDocument();
    expect(screen.getByText("KVM ports up")).toBeInTheDocument();
  });

  it("shows alerts count", () => {
    render(<StatsBar stats={baseStats} />);
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Alerts")).toBeInTheDocument();
  });

  it("alerts value has danger styling when alerts > 0", () => {
    render(<StatsBar stats={{ ...baseStats, alerts: 2 }} />);
    const alertsValue = screen.getByText("2");
    expect(alertsValue.className).toContain("rose");
  });

  it("alerts value does NOT have danger styling when alerts === 0", () => {
    render(<StatsBar stats={{ ...baseStats, alerts: 0 }} />);
    const alertsEl = screen.getByText("0");
    expect(alertsEl.className).not.toContain("rose");
  });

  it("rounds sub-1-kW draw correctly", () => {
    render(<StatsBar stats={{ ...baseStats, watts: 750 }} />);
    expect(screen.getByText("0.75 kW")).toBeInTheDocument();
  });
});
