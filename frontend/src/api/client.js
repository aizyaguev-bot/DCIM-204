const BASE = "";

let _accessToken = null;
let _refreshing = null;

export function setAccessToken(token) {
  _accessToken = token;
}

export function clearAccessToken() {
  _accessToken = null;
}

async function attemptSilentRefresh() {
  if (_refreshing) return _refreshing;
  _refreshing = fetch("/auth/refresh", { method: "POST", credentials: "include" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.access_token) {
        _accessToken = data.access_token;
        return true;
      }
      _accessToken = null;
      return false;
    })
    .catch(() => { _accessToken = null; return false; })
    .finally(() => { _refreshing = null; });
  return _refreshing;
}

function buildHeaders(body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (_accessToken) headers["Authorization"] = `Bearer ${_accessToken}`;
  return headers;
}

async function req(method, path, body) {
  const doFetch = () =>
    fetch(`${BASE}${path}`, {
      method,
      headers: buildHeaders(body),
      credentials: "include",
      body: body ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch();

  // Transparent token refresh on 401
  if (res.status === 401) {
    const ok = await attemptSilentRefresh();
    if (ok) res = await doFetch();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // Devices
  getDevices: ()               => req("GET",    "/api/devices/"),
  createDevice: (d)            => req("POST",   "/api/devices/", d),
  updateDevice: (id, d)        => req("PUT",    `/api/devices/${id}`, d),
  updateLabels: (id, labels)   => req("PATCH",  `/api/devices/${id}/labels`, labels),
  deleteDevice: (id)           => req("DELETE", `/api/devices/${id}`),

  // PDU
  getPduStatus: (id)           => req("GET",    `/api/pdus/${id}/status`),
  outletPower: (id, n, action) => req("POST",   `/api/pdus/${id}/outlets/${n}/power`, { action }),

  // KVM
  getKvmStatus: (id)           => req("GET",    `/api/kvms/${id}/status`),
  getViewerUrl: (id, port)     => req("GET",    `/api/kvms/${id}/ports/${port}/viewer`),
  markKvmFree: (id)            => req("POST",   `/api/kvms/${id}/mark-free`),
};
