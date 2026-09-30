import { useState, useEffect, useMemo, Fragment } from "react";
import { api } from "./api/client";
import Header from "./components/Header";
import StatsBar from "./components/StatsBar";
import PduCard from "./components/PduCard";
import KvmCard from "./components/KvmCard";
import InventoryRackCard from "./components/InventoryRackCard";
import { loadRackItems, MAIN_STORAGE } from "./api/inventory";
import PduDetail from "./pages/PduDetail";
import KvmDetail from "./pages/KvmDetail";
import DcimView from "./pages/DcimView";
import SyncView from "./pages/SyncView";
import ScanView from "./pages/ScanView";
import MonitoringView from "./pages/MonitoringView";
import AddDeviceModal from "./components/AddDeviceModal";
import { useAccounts, AccountSettings, UsersView } from "./accounts";

export default function App() {
  const { mode: accountMode, canOperate, canAdmin, preferences } = useAccounts();
  const [devices, setDevices] = useState([]);
  const [pduStatuses, setPduStatuses] = useState({});   // { id: PduStatus }
  const [kvmStatuses, setKvmStatuses] = useState({});   // { id: KvmStatus }
  const [view, setView] = useState({ kind: "dashboard" });
  const [mainTab, setMainTab] = useState(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return tab === "dcim" ? "racks" : tab === "sync" ? "admin" : ["dashboard", "racks", "inventory", "power", "consoles", "scan", "monitoring", "twin", "admin", "changelog", "account"].includes(tab) ? tab : preferences.start_page;
  });

  const [editMode, setEditMode] = useState(false);
  const [summary, setSummary] = useState("");
  const [version, setVersion] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [deviceError, setDeviceError] = useState("");
  const [rackItems, setRackItems] = useState(null);
  const [rackItemsError, setRackItemsError] = useState("");
  const [adminSection, setAdminSection] = useState(new URLSearchParams(location.search).get("tab") === "sync" ? "mapping" : "devices");
  function navigate(tab, rack) {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    if (rack) url.searchParams.set("rack", rack);
    else url.searchParams.delete("rack");
    history.pushState({ tab, view: {kind:"dashboard"} }, "", url);
    setView({kind:"dashboard"}); setMainTab(tab); setEditMode(false);
  }
  function openDetail(newView) {
    history.pushState({ view: newView, tab: mainTab }, "");
    setView(newView);
  }

  useEffect(() => {
    const onPop = event => { setView(event.state?.view || { kind: "dashboard" }); setMainTab(event.state?.tab || new URLSearchParams(location.search).get("tab") || "dashboard"); setEditMode(false); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const [filter, setFilter] = useState("all");
  const [rackFilter, setRackFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  function openKvmConsole(deviceId, portNumber) {
    if (!canOperate) return;
    fetch(`/api/kvms/${deviceId}/ports/${portNumber}/mark-in-use`, { method: "POST" });
    const popup = window.open(`/api/kvms/${deviceId}/autologin?port=${portNumber}`, "_blank");
    if (popup) {
      const t = setInterval(() => {
        if (popup.closed) {
          clearInterval(t);
          fetch(`/api/kvms/${deviceId}/ports/${portNumber}/mark-free`, { method: "POST" })
            .then(() => loadKvmStatus(deviceId));
        }
      }, 2000);
    }
  }

  const pdus = devices.filter(d => d.kind === "pdu");
  const kvms = devices.filter(d => d.kind === "kvm");
  const racks = useMemo(() => [...new Set(devices.map(d => d.rack).filter(Boolean))].sort(), [devices]);
  const inventoryRacks = useMemo(() => [...new Map(devices.filter(d => d.kind === "rack" && d.rack && (d.model === "Storage" || d.rack === MAIN_STORAGE)).map(d => [d.rack, d])).values()], [devices]);

  useEffect(() => {
    if (mainTab !== "dashboard" || inventoryRacks.length === 0) return;
    let active = true;
    const refresh = async () => {
      try {
        const items = await loadRackItems();
        if (active) { setRackItems(items); setRackItemsError(""); }
      } catch (error) {
        if (active) { setRackItems(null); setRackItemsError(error.message); }
      }
    };
    refresh();
    const timer = setInterval(refresh, preferences.refresh_seconds * 1000);
    return () => { active = false; clearInterval(timer); };
  }, [mainTab, inventoryRacks, preferences.refresh_seconds]);

  // Load devices on mount, then poll statuses every 15s
  useEffect(() => {
    loadDevices();
    fetch("/api/version").then(r => r.json()).then(d => setVersion(d.version)).catch(() => {});
  }, []);

  useEffect(() => {
    if (devices.length === 0) return;
    const refresh = () => {
      pdus.forEach(p => loadPduStatus(p.id));
      kvms.forEach(k => loadKvmStatus(k.id));
    };
    refresh();
    const t = setInterval(refresh, preferences.refresh_seconds * 1000);
    return () => clearInterval(t);
  }, [devices, preferences.refresh_seconds]);

  async function loadDevices() {
    try {
      const data = await api.getDevices();
      setDevices(data);
      setDeviceError("");
    } catch (e) {
      setDeviceError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadPduStatus(id) {
    try {
      const status = await api.getPduStatus(id);
      setPduStatuses(s => ({ ...s, [id]: status }));
      setLastUpdated(new Date());
    } catch (e) { setPduStatuses(s => ({...s, [id]: {device_id:id, reachable:false, outlets:[], error:e.message}})); }
  }

  async function loadKvmStatus(id) {
    try {
      const status = await api.getKvmStatus(id);
      setKvmStatuses(s => ({ ...s, [id]: status }));
      setLastUpdated(new Date());
    } catch (e) { setKvmStatuses(s => ({...s, [id]: {device_id:id, reachable:false, ports:[], error:e.message}})); }
  }

  async function handleRenameOpt(oldName, newName) {
    await api.renameOpt(oldName, newName);
    await loadDevices();
    await refreshAllStatuses();
  }

  async function refreshAllStatuses() {
    await Promise.all([
      ...pdus.map(p => loadPduStatus(p.id)),
      ...kvms.map(k => loadKvmStatus(k.id)),
    ]);
  }

  async function handleMarkKvmFree(id) {
    try {
      await api.markKvmFree(id);
      await loadKvmStatus(id);
    } catch {}
  }

  async function handleOutletAction(device, outletNumber, action, confirmed = false) {
    if (!canOperate) return;
    if (!confirmed && preferences.confirm_power && ["off", "cycle"].includes(action) && !confirm(`Power ${action} ${device.name}, outlet ${outletNumber}?`)) return;
    try {
      await api.outletPower(device.id, outletNumber, action);
      await loadPduStatus(device.id);
    } catch (e) {
      alert(`Action failed: ${e.message}`);
    }
  }

  async function handleAddDevice(payload) {
    try {
      await api.createDevice(payload);
      await loadDevices();
      setAddOpen(false);
    } catch (e) {
      alert(`Failed to add device: ${e.message}`);
    }
  }

  async function handleDeleteDevice(id) {
    if (!confirm("Remove this device?")) return;
    try {
      await api.deleteDevice(id);
      setDevices(d => d.filter(x => x.id !== id));
    } catch (e) {
      alert(`Failed: ${e.message}`);
    }
  }

  const match = (d) => {
    if (rackFilter !== "all" && d.rack !== rackFilter) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    const status = pduStatuses[d.id] || kvmStatuses[d.id];
    const outletMatch = (status?.outlets || []).some(o => o.label.toLowerCase().includes(s));
    const portMatch = (status?.ports || []).some(p => p.label.toLowerCase().includes(s));
    const itemMatch = d.kind === "rack" && (rackItems?.[d.rack] || []).some(item => [item.name, item.serial_number, item.barcode].some(value => value?.toLowerCase().includes(s)));
    return d.name.toLowerCase().includes(s) || (d.ip || "").includes(s) || (d.rack || "").toLowerCase().includes(s) || outletMatch || portMatch || itemMatch;
  };

  const stats = useMemo(() => {
    let outletsOn = 0, outletsTotal = 0, watts = 0, portsMapped = 0, portsTotal = 0, alerts = 0;
    const temps = [], humids = [];
    let leakDetected = false;
    pdus.forEach(p => {
      const s = pduStatuses[p.id];
      if (s?.outlets) {
        outletsOn    += s.outlets.filter(o => o.state === "on").length;
        outletsTotal += s.outlets.length;
        watts        += s.total_watts || 0;
      }
      if (!s?.reachable && s) alerts++;
      if (s?.temperature != null) temps.push(s.temperature);
      if (s?.humidity    != null) humids.push(s.humidity);
      if (s?.leak_detected)       leakDetected = true;
    });
    kvms.forEach(k => {
      const s = kvmStatuses[k.id];
      if (s?.ports) {
        portsMapped += s.ports.filter(p => p.label?.trim() && !/^port\s*\d+$/i.test(p.label.trim())).length;
        portsTotal  += s.ports.length;
      }
    });
    const tempMin = temps.length ? Math.min(...temps) : null;
    const tempMax = temps.length ? Math.max(...temps) : null;
    const humMin  = humids.length ? Math.min(...humids) : null;
    const humMax  = humids.length ? Math.max(...humids) : null;
    return { deviceCount: pdus.length + kvms.length, outletsOn, outletsTotal, watts, portsMapped, portsTotal, alerts,
             tempMin, tempMax, humMin, humMax, leakDetected, hasSensors: temps.length > 0 || humids.length > 0 };
  }, [devices, pduStatuses, kvmStatuses]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-zinc-400">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">⠋</div>
          <div>Connecting to Lab Manager backend…</div>
          <div className="text-xs text-zinc-600 mt-1">Make sure the FastAPI server is running on port 8000</div>
        </div>
      </div>
    );
  }

  const pageInfo = {
    racks: ["Racks", "Shelf layout, equipment and power across Lab 204."],
    inventory: ["Inventory", "Servers and equipment with their location, owner, serial and barcode."],
    twin: ["3D Twin", "Explore the lab and its saved rack layout."],
    changelog: ["Changelog", "Changes and releases in Lab Manager."],
  }[mainTab];
  const updatedText = lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()}.` : "Waiting for device readings.";
  const visiblePdus = pdus.filter(match);
  const visibleKvms = kvms.filter(match).sort((a, b) => a.name.localeCompare(b.name));
  const visibleInventoryRacks = inventoryRacks.filter(match).sort((a, b) => a.rack.localeCompare(b.rack));

  return (
    <div className="min-h-screen flex flex-col">
      <Header activeTab={mainTab} onNavigate={navigate} summary={summary} editMode={editMode} onEditChange={value => setEditMode(canOperate && value)} onHome={() => navigate("dashboard")}
        onAccount={() => navigate("account")} onUsers={() => {navigate("admin");setAdminSection("users");}} />
      {deviceError && <div role="alert" className="mx-4 mb-4 rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">Device list could not load: {deviceError}. <button className="underline" onClick={loadDevices}>Retry</button></div>}
      {mainTab === "admin" && view.kind === "dashboard" && <nav className="app-subnav" aria-label="Administration">{[["devices","Devices"],...(accountMode === "accounts" && canAdmin ? [["users","Users"]] : []),["mapping","PDU–KVM mapping"],["help","Help & About"]].map(([id,label])=><button key={id} aria-current={adminSection===id ? "page" : undefined} onClick={()=>setAdminSection(id)}>{label}</button>)}</nav>}
      {view.kind === "dashboard" && pageInfo && <div className="page-intro"><h1>{pageInfo[0]}</h1><p>{pageInfo[1]} {updatedText}</p></div>}
      {view.kind === "dashboard" && mainTab === "dashboard" && <StatsBar stats={stats} />}
      {view.kind === "dashboard" && ["racks", "inventory", "power", "changelog"].includes(mainTab) && (
        <DcimView section={mainTab} editMode={editMode} onSummary={setSummary}
          devices={devices}
          pduStatuses={pduStatuses}
          kvmStatuses={kvmStatuses}
          onOutletAction={async (pduId, outletNumber, action) => {
            const device = pdus.find(p => p.id === pduId);
            if (device) await handleOutletAction(device, outletNumber, action);
          }}
          onLabelChange={async (pduId, newLabels) => {
            await api.updateLabels(pduId, newLabels);
            await loadDevices();
            await refreshAllStatuses();
          }}
          onRenameOpt={handleRenameOpt}
          onRefresh={loadDevices}
        />
      )}

      {view.kind === "dashboard" && mainTab === "scan" && <ScanView />}
      {view.kind === "dashboard" && mainTab === "account" && <AccountSettings />}
      {view.kind === "dashboard" && mainTab === "admin" && adminSection === "users" && canAdmin && <UsersView />}
      {view.kind === "dashboard" && mainTab === "monitoring" && <MonitoringView />}

      {view.kind === "dashboard" && mainTab === "twin" && (
        <iframe title="3D Digital Twin" src="/twin/index.html?embed=1" className="w-full flex-1 border-0"
          style={{ minHeight: "calc(100vh - 150px)" }} allow="fullscreen" />
      )}

      {view.kind === "dashboard" && mainTab === "admin" && adminSection === "mapping" && (
        <SyncView
          devices={devices}
          pduStatuses={pduStatuses}
          kvmStatuses={kvmStatuses}
        />
      )}

      {view.kind === "dashboard" && ["dashboard", "power", "consoles"].includes(mainTab) && (
        <main className="device-page">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4"><div><h1 className="text-2xl font-bold text-white">{mainTab === "consoles" ? "Remote consoles" : mainTab === "power" ? "Power distribution units" : "Dashboard"}</h1><p className="text-sm text-zinc-400 mt-1">{pdus.length} PDUs · {kvms.length} KVMs · {updatedText}</p></div><input aria-label="Search devices" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search devices, ports, IPs…" className="bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm w-full sm:w-72"/></div>
          {mainTab === "dashboard" && <Toolbar filter={filter} setFilter={setFilter} rackFilter={rackFilter} setRackFilter={setRackFilter} racks={racks}
            count={(filter === "all" || filter === "pdus" ? visiblePdus.length : 0) + (filter === "all" || filter === "kvms" ? visibleKvms.length : 0)}
            rackCount={filter === "all" || filter === "racks" ? visibleInventoryRacks.length : 0} onAdd={canAdmin ? () => setAddOpen(true) : null} />}
          <div className="device-grid">
            {(mainTab === "power" || (mainTab === "dashboard" && (filter === "all" || filter === "pdus"))) && visiblePdus.map(p =>
              <PduCard key={p.id} device={p} status={pduStatuses[p.id]}
                onOpen={() => openDetail({ kind: "pdu", id: p.id })}
                onOutletAction={(n, a) => handleOutletAction(p, n, a)}
              />
            )}
            {(mainTab === "consoles" || (mainTab === "dashboard" && (filter === "all" || filter === "kvms"))) && visibleKvms.map(k =>
              <KvmCard key={k.id} device={k} status={kvmStatuses[k.id]}
                onOpen={() => openDetail({ kind: "kvm", id: k.id })}
                onPortClick={(port) => openKvmConsole(k.id, port.number)}
                onMarkFree={() => handleMarkKvmFree(k.id)}
              />
            )}
            {mainTab === "dashboard" && (filter === "all" || filter === "racks") && visibleInventoryRacks.map(rack =>
              <InventoryRackCard key={rack.rack} rack={rack} items={rackItems ? rackItems[rack.rack] || [] : null} error={rackItemsError}
                onOpen={() => navigate("racks", rack.rack)} />
            )}
            {pdus.length + kvms.length + inventoryRacks.length === 0 && (
              <div className="col-span-full text-center text-zinc-500 py-16">
                <div className="text-2xl mb-3">No devices yet</div>
                <button disabled={!canAdmin} onClick={() => setAddOpen(true)} className="bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium px-4 py-2 rounded-lg">
                  + Add your first device
                </button>
              </div>
            )}
          </div>
        </main>
      )}

      {view.kind === "dashboard" && mainTab === "admin" && adminSection === "devices" && <main className="p-4 w-full mx-auto">
        <div className="flex items-center justify-between mb-5"><div><h1 className="text-xl font-semibold text-white">Devices</h1><p className="text-xs text-zinc-500 mt-1">Manage the connected PDUs and KVMs.</p></div><button disabled={!canAdmin} className="edit-toggle active" onClick={()=>setAddOpen(true)}>+ Add Device</button></div>
        <div className="border border-zinc-800 rounded-xl overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-zinc-900 text-zinc-500"><tr>{["Name","Type","Address","Rack","Status","Actions"].map(h=><th key={h} className="p-3 font-medium">{h}</th>)}</tr></thead><tbody>{devices.filter(d=>["pdu","kvm"].includes(d.kind)).map(d=><tr key={d.id} className="border-t border-zinc-800"><td className="p-3 font-medium text-white">{d.name}</td><td className="p-3 uppercase">{d.kind}</td><td className="p-3 font-mono">{d.ip}</td><td className="p-3">{d.rack}</td><td className="p-3">{(pduStatuses[d.id] || kvmStatuses[d.id])?.reachable === true ? "Online" : (pduStatuses[d.id] || kvmStatuses[d.id])?.reachable === false ? "Offline" : "Pending"}</td><td className="p-3 whitespace-nowrap"><button className="text-nv-300 mr-4" onClick={()=>openDetail({kind:d.kind,id:d.id})}>Details</button><button disabled={!canAdmin} className="text-rose-400" onClick={()=>handleDeleteDevice(d.id)}>Remove</button></td></tr>)}</tbody></table></div>
      </main>}
      {view.kind === "dashboard" && mainTab === "admin" && adminSection === "help" && <main className="p-6 max-w-3xl text-sm space-y-5">
        <h1 className="text-xl font-semibold text-white">Help & About</h1><p>Lab Manager connects to your Raritan PDUs and KVMs. Device data refreshes every 15 seconds while the page is open.</p>
        <p>Racks opens in view mode. Use Edit to rename assets, assign owners or rearrange shelves. Scan & Track supports equipment, shelf and whole-rack barcodes, including main storage.</p>
        <p>Ping Monitor runs on the backend: every 5 minutes from 07:00–20:00 and every 30 minutes overnight, using Israel time. It includes each server's PDU and KVM connections and email delivery status.</p>
        <p>Power load percentages are estimates using the existing 16 A rating assumption. Email thresholds use measured inlet values and separate configuration.</p>
        <p>Access continues to use the VM's existing authentication. Version: <span className="font-mono">{version || "Unknown"}</span>.</p>
      </main>}

      {view.kind === "pdu" && (
        <PduDetail
          device={pdus.find(p => p.id === view.id)}
          status={pduStatuses[view.id]}
          onBack={() => history.back()}
          onOutletAction={(n, a, confirmed) => handleOutletAction(pdus.find(p => p.id === view.id), n, a, confirmed)}
          onDelete={() => { handleDeleteDevice(view.id); history.back(); }}
          onLabelsSave={async (labels) => {
            await api.updateLabels(view.id, labels);
            await loadDevices();
            await refreshAllStatuses();
          }}
        />
      )}

      {view.kind === "kvm" && (
        <KvmDetail
          device={kvms.find(k => k.id === view.id)}
          status={kvmStatuses[view.id]}
          onBack={() => history.back()}
          onPortClick={(port) => openKvmConsole(view.id, port.number)}
          onDelete={() => { handleDeleteDevice(view.id); history.back(); }}
          onMarkFree={() => handleMarkKvmFree(view.id)}
          onLabelsSave={async (labels) => {
            await api.updateLabels(view.id, labels);
            await loadDevices();
            await refreshAllStatuses();
          }}
        />
      )}

      {addOpen && <AddDeviceModal racks={racks} onClose={() => setAddOpen(false)} onAdd={handleAddDevice} />}

      <footer className="app-footer"><span>Lab Manager · Raritan PX4 + KX III / LX II · Lab 204</span><span>Auto-refreshes every {preferences.refresh_seconds}s{version ? ` · ${version}` : ""}</span></footer>
    </div>
  );
}

function Toolbar({ filter, setFilter, rackFilter, setRackFilter, racks, count, rackCount, onAdd }) {
  const Btn = ({ v, label }) => (
    <button onClick={() => setFilter(v)} aria-pressed={filter === v}
      className={`device-filter ${filter === v ? "active" : ""}`}>
      {label}
    </button>
  );
  return (
    <div className="device-toolbar">
      <div className="flex gap-1.5" role="group" aria-label="Device type"><Btn v="all" label="All" /><Btn v="pdus" label="PDUs" /><Btn v="kvms" label="KVMs" /><Btn v="racks" label="Storage" /></div>
      <label className="flex items-center gap-2 text-xs text-zinc-500">Rack
      <select aria-label="Rack" value={rackFilter} onChange={e => setRackFilter(e.target.value)} className="device-rack-filter">
        <option value="all">All racks</option>
        {racks.map(r => <option key={r}>{r}</option>)}
      </select>
      </label>
      <span className="device-count" aria-live="polite">{count} {count === 1 ? "device" : "devices"}{rackCount > 0 && ` · ${rackCount} storage ${rackCount === 1 ? "rack" : "racks"}`}</span>
      {onAdd && <button className="device-add" onClick={onAdd}><span aria-hidden="true">+</span> Add Device</button>}
    </div>
  );
}
