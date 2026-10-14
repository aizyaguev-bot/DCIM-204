import { useAccounts, UserMenu } from "../accounts";
import nvidiaLogo from "../assets/nvidia-logo.svg";
const tabs = [
  ["dashboard", "Dashboard", "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"],
  ["racks", "Racks", "M4 3h16v7H4zM4 14h16v7H4zM7 6h.01M7 17h.01"],
  ["inventory", "Inventory", "M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"],
  ["power", "Power", "m13 2-9 12h8l-1 8 9-12h-8z"],
  ["consoles", "Consoles", "M3 4h18v13H3zM8 21h8M12 17v4"],
  ["scan", "Scan & Track", "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M8 8v8M12 8v8M16 8v8"],
  ["monitoring", "Ping Monitor", "M2 12h4l3-8 6 16 3-8h4"],
  ["twin", "3D Twin", "m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"],
  ["admin", "Admin", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"],
  ["changelog", "Changelog", "M12 20h9M16 3l5 5-12 12-6 1 1-6z"],
];
export default function Header({ activeTab, onNavigate, summary, editMode, onEditChange, onHome, onAccount, onUsers }) {
  const {canOperate} = useAccounts();
  return <header className="app-header">
    <button className="app-brand" onClick={onHome} title={summary || "Open Dashboard"}>
      <img src={nvidiaLogo} alt="NVIDIA" width="104" height="20"/><i aria-hidden="true"/>
      <span><strong>Lab Manager</strong><small>Lab 204 · Yokneam</small></span>
    </button>
    <nav className="app-tabs" aria-label="Main navigation">
      {tabs.map(([id, label]) => <button key={id} onClick={() => onNavigate(id)} aria-current={activeTab === id ? "page" : undefined}>
        {label}
      </button>)}
    </nav>
    <div className="app-header-actions">
      {canOperate && ["racks", "inventory"].includes(activeTab) && <button className={`edit-toggle ${editMode ? "active" : ""}`}
        aria-pressed={editMode} title="Edit rack layout and inventory" onClick={() => onEditChange(!editMode)}>
        {editMode ? "✓ Done" : "✎ Edit"}
      </button>}
      <UserMenu onAccount={onAccount} onUsers={onUsers}/>
    </div>
  </header>;
}
