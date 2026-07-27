import { useState, useEffect, useMemo, Fragment } from "react";
import { api } from "./api/client";
import Header from "./components/Header";
import StatsBar from "./components/StatsBar";
import PduCard from "./components/PduCard";
import KvmCard from "./components/KvmCard";
import PduDetail from "./pages/PduDetail";
import KvmDetail from "./pages/KvmDetail";
import DcimView from "./pages/DcimView";
import AddDeviceModal from "./components/AddDeviceModal";

export default function App() {
  const [devices, setDevices] = useState([]);
  const [pduStatuses, setPduStatuses] = useState({});   // { id: PduStatus }
  const [kvmStatuses, setKvmStatuses] = useState({});   // { id: KvmStatus }
  const [view, setView] = useState({ kind: "dashboard" });
  const [mainTab, setMainTab] = useState("dashboard");  // "dashboard" | "dcim"

  function openDetail(newView) {
    history.pushState({ view: newView }, "");
    setView(newView);
  }

  useEffect(() => {
    const onPop = () => setView({ kind: "dashboard" });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const [filter, setFilter] = useState("all");
  const [rackFilter, setRackFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  function openKvmConsole(deviceId, portNumber) {
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

  // Load devices on mount, then poll statuses every 15s
  useEffect(() => {
    loadDevices();
  }, []);

  useEffect(() => {
    if (devices.length === 0) return;
    const refresh = () => {
      pdus.forEach(p => loadPduStatus(p.id));
      kvms.forEach(k => loadKvmStatus(k.id));
    };
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [devices]);

  async function loadDevices() {
    try {
      const data = await api.getDevices();
      setDevices(data);
    } catch (e) {
      console.error("Failed to load devices:", e);
    } finally {
      setLoading(false);
    }
  }

  async function loadPduStatus(id) {
    try {
      const status = await api.getPduStatus(id);
      setPduStatuses(s => ({ ...s, [id]: status }));
    } catch {}
  }

  async function loadKvmStatus(id) {
    try {
      const status = await api.getKvmStatus(id);
      setKvmStatuses(s => ({ ...s, [id]: status }));
    } catch {}
  }

  async function handleMarkKvmFree(id) {
    try {
      await api.markKvmFree(id);
      await loadKvmStatus(id);
    } catch {}
  }

  async function handleOutletAction(device, outletNumber, action) {
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
    return d.name.toLowerCase().includes(s) || d.ip.includes(s) || (d.rack || "").toLowerCase().includes(s) || outletMatch || portMatch;
  };

  const stats = useMemo(() => {
    let outletsOn = 0, outletsTotal = 0, watts = 0, portsActive = 0, portsTotal = 0, alerts = 0;
    pdus.forEach(p => {
      const s = pduStatuses[p.id];
      if (s?.outlets) {
        outletsOn    += s.outlets.filter(o => o.state === "on").length;
        outletsTotal += s.outlets.length;
        watts        += s.total_watts || 0;
      }
      if (!s?.reachable && s) alerts++;
    });
    kvms.forEach(k => {
      const s = kvmStatuses[k.id];
      if (s?.ports) {
        portsActive += s.ports.filter(p => /^opt/i.test(p.label || "")).length;
        portsTotal  += s.ports.length;
      }
    });
    return { deviceCount: devices.length, outletsOn, outletsTotal, watts, portsActive, portsTotal, alerts };
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

  const visiblePdus = pdus.filter(match);
  const visibleKvms = kvms.filter(match).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="min-h-screen flex flex-col">
      <Header search={search} setSearch={setSearch} onAdd={() => setAddOpen(true)} onHome={() => { if (view.kind !== "dashboard") history.back(); }} />
      <StatsBar stats={stats} />

      {/* top-level tab bar — only visible on the root dashboard level */}
      {view.kind === "dashboard" && (
        <div className="border-b border-zinc-800/60 bg-zinc-950/40">
          <div className="max-w-[1600px] mx-auto px-6 flex gap-1 pt-2">
            {[
              { id: "dashboard", label: "Dashboard" },
              { id: "dcim",      label: "DCIM" },
            ].map(t => (
              <button key={t.id} onClick={() => setMainTab(t.id)}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition ${
                  mainTab === t.id
                    ? "text-nv-400 border-nv-400 bg-nv-400/5"
                    : "text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/40"
                }`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {view.kind === "dashboard" && mainTab === "dcim" && (
        <DcimView
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
            await loadPduStatus(pduId);
          }}
          onRefresh={loadDevices}
        />
      )}

      {view.kind === "dashboard" && mainTab === "dashboard" && (
        <main className="flex-1 px-6 py-5 max-w-[1600px] w-full mx-auto">
          <Toolbar filter={filter} setFilter={setFilter} rackFilter={rackFilter} setRackFilter={setRackFilter} racks={racks} />
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-5">
            {(filter === "all" || filter === "pdus") && visiblePdus.map(p =>
              <PduCard key={p.id} device={p} status={pduStatuses[p.id]}
                onOpen={() => openDetail({ kind: "pdu", id: p.id })}
                onOutletAction={(n, a) => handleOutletAction(p, n, a)}
              />
            )}
            {(filter === "all" || filter === "kvms") && visibleKvms.map(k =>
              <KvmCard key={k.id} device={k} status={kvmStatuses[k.id]}
                onOpen={() => openDetail({ kind: "kvm", id: k.id })}
                onPortClick={(port) => openKvmConsole(k.id, port.number)}
                onMarkFree={() => handleMarkKvmFree(k.id)}
              />
            )}
            {devices.length === 0 && (
              <div className="col-span-full text-center text-zinc-500 py-16">
                <div className="text-2xl mb-3">No devices yet</div>
                <button onClick={() => setAddOpen(true)} className="bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium px-4 py-2 rounded-lg">
                  + Add your first device
                </button>
              </div>
            )}
          </div>
        </main>
      )}

      {view.kind === "pdu" && (
        <PduDetail
          device={pdus.find(p => p.id === view.id)}
          status={pduStatuses[view.id]}
          onBack={() => history.back()}
          onOutletAction={(n, a) => handleOutletAction(pdus.find(p => p.id === view.id), n, a)}
          onDelete={() => { handleDeleteDevice(view.id); history.back(); }}
          onLabelsSave={async (labels) => {
            await api.updateLabels(view.id, labels);
            await loadDevices();
            await loadPduStatus(view.id);
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
            await loadKvmStatus(view.id);
          }}
        />
      )}

      {addOpen && <AddDeviceModal racks={racks} onClose={() => setAddOpen(false)} onAdd={handleAddDevice} />}

      <footer className="border-t border-zinc-800/80 bg-zinc-950/70 mt-auto">
        <div className="max-w-[1600px] mx-auto px-6 py-3 text-[11px] text-zinc-500 flex justify-between">
          <span>Lab Manager · Raritan PX4 + KX III / LX II</span>
          <span>Auto-refreshes every 15s</span>
        </div>
      </footer>
    </div>
  );
}

function Toolbar({ filter, setFilter, rackFilter, setRackFilter, racks }) {
  const Btn = ({ v, label }) => (
    <button onClick={() => setFilter(v)}
      className={`px-3 py-1.5 rounded-md text-sm transition ${filter === v ? "bg-zinc-100 text-zinc-900 font-medium" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800 border border-zinc-800"}`}>
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Btn v="all" label="All" /><Btn v="pdus" label="PDUs" /><Btn v="kvms" label="KVMs" />
      <div className="w-px h-6 bg-zinc-800 mx-1" />
      <span className="text-xs text-zinc-500">Rack:</span>
      <select value={rackFilter} onChange={e => setRackFilter(e.target.value)}
        className="bg-zinc-900 border border-zinc-800 rounded-md text-sm px-2 py-1.5 focus:outline-none focus:border-nv-400/60">
        <option value="all">All racks</option>
        {racks.map(r => <option key={r}>{r}</option>)}
      </select>
    </div>
  );
}
