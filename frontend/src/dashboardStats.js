import { deviceState } from "./api/client.js";

// Dashboard totals for StatsBar. A PDU or KVM that does not answer counts as one alert.
export function dashboardStats(pdus, kvms, pduStatuses = {}, kvmStatuses = {}) {
  let outletsOn = 0, outletsTotal = 0, watts = 0, wattsKnown = 0, wattsComplete = true, portsMapped = 0, portsTotal = 0, alerts = 0;
  const temps = [], humids = [];
  let leakDetected = false;
  pdus.forEach(p => {
    const s = pduStatuses[p.id];
    if (s?.outlets) {
      outletsOn    += s.outlets.filter(o => o.state === "on").length;
      outletsTotal += s.outlets.length;
      if (s.reachable && s.total_watts != null) { watts += s.total_watts; wattsKnown++; }
    }
    if (!s?.reachable || s.total_watts == null || s.watts_complete !== true) wattsComplete = false;
    if (deviceState(s) === "offline") alerts++;
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
    if (deviceState(s) === "offline") alerts++;
  });
  const tempMin = temps.length ? Math.min(...temps) : null;
  const tempMax = temps.length ? Math.max(...temps) : null;
  const humMin  = humids.length ? Math.min(...humids) : null;
  const humMax  = humids.length ? Math.max(...humids) : null;
  return { deviceCount: pdus.length + kvms.length, outletsOn, outletsTotal, watts: wattsKnown ? watts : null, wattsComplete, portsMapped, portsTotal, alerts,
           tempMin, tempMax, humMin, humMax, leakDetected, hasSensors: temps.length > 0 || humids.length > 0 };
}
