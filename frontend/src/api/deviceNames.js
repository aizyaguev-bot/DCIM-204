// Device name sync API (NS): status rows (database only, Viewer), live compare with the device and the push (Operator).
// Unsafe requests get the X-DCIM-CSRF header from the global fetch wrapper in accounts.jsx, like every other /api call.
// Errors carry status and the server's detail, as in api/client.js; the raw response body is never put in the message.
async function req(method, path, body, signal) {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const err = new Error(`Request failed (${res.status})`);
    err.status = res.status;
    try {
      const detail = JSON.parse(await res.text()).detail;
      err.detail = typeof detail === "string" ? detail
        : Array.isArray(detail) ? detail.map(e => e?.msg).filter(Boolean).join("; ") || undefined
        : undefined;
    } catch {}
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// deviceIds: one id or a list; omitted/empty = every device.
export function getNameSyncStatus(deviceIds, { signal } = {}) {
  const ids = [deviceIds].flat().filter(id => id != null && id !== "");
  const query = ids.map(id => `device_id=${encodeURIComponent(id)}`).join("&");
  return req("GET", `/api/devices/name-sync/status${query ? `?${query}` : ""}`, undefined, signal);
}

// Contacts the device (about 6 s at most on the server side).
export function getDeviceNames(id, { signal } = {}) {
  return req("GET", `/api/devices/${encodeURIComponent(id)}/device-names`, undefined, signal);
}

// body: { ports: ["5", ...], expected: { "5": "<name the compare showed for writing>" } } (see pushBody in
// ../deviceNames.js). Never sent without ports: there is no "write everything" request.
export function pushDeviceNames(id, body) {
  const ports = Array.isArray(body?.ports) ? body.ports.map(String) : [];
  if (!ports.length || !body?.expected || typeof body.expected !== "object") {
    return Promise.reject(new Error("Select the ports to write first."));
  }
  return req("POST", `/api/devices/${encodeURIComponent(id)}/device-names/push`, { ports, expected: body.expected });
}
