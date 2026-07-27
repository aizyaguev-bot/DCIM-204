import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Header from "../components/Header";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    json: () => Promise.resolve({ version: "v1.2.0" }),
  });
});
afterEach(() => vi.restoreAllMocks());

const defaultProps = {
  search: "",
  setSearch: vi.fn(),
  onAdd: vi.fn(),
  onHome: vi.fn(),
};

describe("Header", () => {
  it("renders the app name 'Lab Manager'", () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByText("Lab Manager")).toBeInTheDocument();
  });

  it("renders the subtitle", () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByText("Raritan PDU + KVM control")).toBeInTheDocument();
  });

  it("shows '…' while version is loading", () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByTestId("version-badge").textContent).toBe("…");
  });

  it("shows version from /api/version once loaded", async () => {
    render(<Header {...defaultProps} />);
    await waitFor(() =>
      expect(screen.getByTestId("version-badge").textContent).toBe("v1.2.0")
    );
  });

  it("shows '—' when /api/version fetch fails", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<Header {...defaultProps} />);
    await waitFor(() =>
      expect(screen.getByTestId("version-badge").textContent).toBe("—")
    );
  });

  it("renders the search input with current value", () => {
    render(<Header {...defaultProps} search="findme" />);
    expect(screen.getByPlaceholderText(/search devices/i).value).toBe("findme");
  });

  it("calls setSearch when typing in the search box", () => {
    const setSearch = vi.fn();
    render(<Header {...defaultProps} setSearch={setSearch} />);
    fireEvent.change(screen.getByPlaceholderText(/search devices/i), { target: { value: "rack-01" } });
    expect(setSearch).toHaveBeenCalledWith("rack-01");
  });

  it("calls onAdd when 'Add Device' is clicked", () => {
    const onAdd = vi.fn();
    render(<Header {...defaultProps} onAdd={onAdd} />);
    fireEvent.click(screen.getByText("Add Device"));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("calls onHome when the logo button is clicked", () => {
    const onHome = vi.fn();
    render(<Header {...defaultProps} onHome={onHome} />);
    fireEvent.click(screen.getByText("Lab Manager").closest("button"));
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});
