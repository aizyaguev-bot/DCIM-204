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
  // Rename a server everywhere. { dryRun: true } previews it (plan_revision included); { planRevision } applies only
  // if nothing changed since that preview (else 409).
  renameOpt:   (oldName, newName, { dryRun, planRevision } = {}) => req("POST", "/api/devices/rename-opt", {
    old_name: oldName, new_name: newName, ...(dryRun ? { dry_run: true } : {}), ...(planRevision ? { plan_revision: planRevision } : {}) }),
  deleteDevice: (id)          => req("DELETE", `/api/devices/${id}`),
  getSyncMap:   ()             => req("GET",    "/api/devices/sync-map"),
  getConnections: ()          => req("GET",    "/api/devices/connections"),
  downloadConnectionsCsv: async () => {
    const response = await fetch(`${BASE}/api/devices/connections.csv`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(typeof data.detail === "string" ? data.detail : `CSV download failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const filename = /filename="?(lab-connections-\d{4}-\d{2}-\d{2}\.csv)"?/i.exec(response.headers.get("Content-Disposition") || "")?.[1] || "lab-connections.csv";
    return { blob: await response.blob(), filename };
  },
  // expected: the label the page showed; the server refuses (409) if the port changed since. Omit for old callers.
  setDirectLabel: (deviceId, port, label, expected) => req("PATCH", "/api/devices/direct-label", { device_id: deviceId, port: String(port), label, ...(expected !== undefined ? { expected } : {}) }),
  // Server-centric view: each server with its rack/slot and PDU/KVM ports, plus empty ports.
  getLocations: ()             => req("GET",    "/api/devices/locations"),
  // body: { server, target_server | target_ports, target_rack, target_slot, swap, dry_run }; dry_run previews only.
  moveServer:   (body)         => req("POST",   "/api/devices/move-server", body),

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
