const BASE = "";  // Vite proxy forwards /api → http://localhost:8000

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`${res.status}: ${text}`);
    err.status = res.status;
    try {
      const detail = JSON.parse(text).detail;
      err.detail = typeof detail === "string" ? detail
        : Array.isArray(detail) ? detail.map(e => e?.msg).filter(Boolean).join("; ") || undefined
        : undefined;
    } catch {}
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // Devices
  getDevices: ()              => req("GET",    "/api/devices/"),
  createDevice: (d)           => req("POST",   "/api/devices/", d),
  updateDevice: (id, d)       => req("PUT",    `/api/devices/${id}`, d),
  updateLabels: (id, labels)  => req("PATCH",  `/api/devices/${id}/labels`, labels),
  renameOpt:   (oldName, newName) => req("POST", "/api/devices/rename-opt", { old_name: oldName, new_name: newName }),
  deleteDevice: (id)          => req("DELETE", `/api/devices/${id}`),
  getSyncMap:   ()             => req("GET",    "/api/devices/sync-map"),
  setDirectLabel: (deviceId, port, label) => req("PATCH", "/api/devices/direct-label", { device_id: deviceId, port: String(port), label }),

  // PDU
  getPduStatus: (id)          => req("GET",    `/api/pdus/${id}/status`),
  outletPower: (id, n, action)=> req("POST",   `/api/pdus/${id}/outlets/${n}/power`, { action }),
  maintenanceList: ()         => req("GET",    "/api/pdus/maintenance"),
  maintenanceShutdown: (id, password, reason) => req("POST", `/api/pdus/${encodeURIComponent(id)}/maintenance/shutdown`, { password, reason }),
  maintenanceRestore:  (id, password)         => req("POST", `/api/pdus/${encodeURIComponent(id)}/maintenance/restore`, { password }),

  // KVM
  getKvmStatus: (id)          => req("GET",    `/api/kvms/${id}/status`),
  getViewerUrl: (id, port)    => req("GET",    `/api/kvms/${id}/ports/${port}/viewer`),
  markKvmFree: (id)           => req("POST",   `/api/kvms/${id}/mark-free`),
};
