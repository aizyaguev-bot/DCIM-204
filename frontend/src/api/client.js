const BASE = "";  // Vite proxy forwards /api → http://localhost:8000

async function req(method, path, body, headers) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
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
  // revision: labels_revision of the device the label map was built from; a stale one gets 409.
  updateLabels: (id, labels, revision) => req("PATCH", `/api/devices/${id}/labels`, labels, revision ? { "If-Match": revision } : undefined),
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

// "unavailable": the status request itself failed, so the device state is not known (not an alert).
// "error": the device answered but reported an error, e.g. a KVM that rejects its saved sign-in.
export function deviceState(status) {
  if (!status) return "unknown";
  if (status.requestFailed) return "unavailable";
  if (status.reachable === false) return "offline";
  if (status.reachable && status.error) return "error";
  return status.reachable ? "online" : "unknown";
}
export const STATE_TEXT = { online: "Online", offline: "Offline", error: "Error", unavailable: "Status unavailable", unknown: "Unknown" };
export const STATE_DOT = { online: "online", offline: "offline", error: "warning", unavailable: "unknown", unknown: "unknown" };

export const errorMessage = e => e?.detail || e?.message || String(e);
