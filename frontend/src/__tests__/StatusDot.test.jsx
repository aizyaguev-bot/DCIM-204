import { render, screen } from "@testing-library/react";
import StatusDot from "../components/StatusDot";

const STATUS_CLASSES = {
  online:  ["bg-emerald-400"],
  active:  ["bg-emerald-400"],
  warning: ["bg-amber-400"],
  offline: ["bg-rose-500"],
  idle:    ["bg-zinc-500"],
  empty:   ["bg-zinc-700"],
  unknown: ["bg-zinc-600"],
};

describe("StatusDot", () => {
  Object.entries(STATUS_CLASSES).forEach(([status, classes]) => {
    it(`renders correct color classes for status="${status}"`, () => {
      const { container } = render(<StatusDot status={status} />);
      const dot = container.firstChild;
      expect(dot.tagName).toBe("SPAN");
      classes.forEach(cls => expect(dot.className).toContain(cls));
    });
  });

  it("falls back to bg-zinc-500 for unknown status string", () => {
    const { container } = render(<StatusDot status="bogus" />);
    expect(container.firstChild.className).toContain("bg-zinc-500");
  });

  it("renders a small rounded element", () => {
    const { container } = render(<StatusDot status="online" />);
    const dot = container.firstChild;
    expect(dot.className).toContain("rounded-full");
    expect(dot.className).toContain("w-2");
    expect(dot.className).toContain("h-2");
  });
});
