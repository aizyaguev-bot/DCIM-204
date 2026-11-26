import { useLabData } from "../window/labWindowContext.js";
import { windowKey } from "./serverKey.js";

// A server name that opens its window (Viewer and up). It is a button only when the name is a server the provider
// knows (windowKey(label) in the server list; removed servers count for Admins only); otherwise the text as it is, so a
// placeholder ("KVM Power"), a default port name or an unknown label never looks clickable.
//   <ServerLink label="OPT23 (PSU1)"/>            the label is the text
//   <ServerLink serverKey="opt23">OPT23</ServerLink>   React keeps `key` for itself: pass the key as serverKey
//   sec: "units" | "activity" | "move"            the part of the window to open on
export default function ServerLink({ label = "", serverKey = null, sec = null, className = "lab-window-link", children = null }) {
  const { servers, openServer } = useLabData("servers");
  const key = serverKey || windowKey(label);
  const text = children ?? label;
  if (!key || !servers.some(s => s.key === key)) return text;
  return <button type="button" className={className} data-server-link={key} dir="auto"
    title={`Open ${String(label || key)}`} onClick={e => { e.stopPropagation(); openServer(key, sec ? { sec } : {}); }}>{text}</button>;
}
