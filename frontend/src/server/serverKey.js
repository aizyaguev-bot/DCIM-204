// Which labels open a server window, and under which key. Pure (no React, no DOM), so node --test imports it.
//
// A window is keyed by the server's identity (api/locations.js serverIdentity: "OPTN45 (PSU2)" -> "optn45"), so every
// feed of a server opens the same window. The frontend serverIdentity has no placeholder check, so windowKey adds the
// backend's: default port names ("Outlet 3", "Port 3", "") and placeholder labels ("Empty", "KVM Power", "Spare", "--")
// are never servers and open nothing.
import { serverIdentity } from "../api/locations.js";

// Byte for byte the same text as DcimView.jsx NON_SERVER_LABEL, backend/app/ping_monitor.py _NON_SERVER_LABEL and
// lab-twin/app.js NON_SERVER_LABEL (server-window.test.js keeps them equal).
export const NON_SERVER_LABEL = /^(empty|kvm[\s_-]*power|pdu|spare|free|n\/a|-+)$/i;
const DEFAULT_PORT_LABEL = /^((outlet|port)\s*\d+)?$/i;

// A label that names a server: not blank, not a default port name, not a placeholder.
export function isServerLabel(label) {
  const text = String(label ?? "").trim();
  return !!text && !DEFAULT_PORT_LABEL.test(text) && !NON_SERVER_LABEL.test(text);
}

// The window key of a label: its server identity, or null when the label is not a server.
export function windowKey(label) {
  return isServerLabel(label) ? serverIdentity(label) : null;
}
