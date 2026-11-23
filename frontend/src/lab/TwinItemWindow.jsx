// STUB (WP-0, read-only). WP-DW replaces the body (v2 §W.4): 3D place, status, id, notes, "Contains N items", Operator
// [Edit in 3D] and Delete from 3D….
// Props: { target: { kind: "twin", id: <lab-data.json items[] / storage[] / setups[] id> }, onClose }
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell, { WindowSection } from "../window/WindowShell.jsx";
import { classifyTwin } from "./twinRecords.js";
import { liveForTwin } from "./labIndex.js";

export function findTwinRecord(doc, id) {
  for (const [list, type] of [["items", null], ["storage", "storage"], ["setups", "setup"]]) {
    const hit = (Array.isArray(doc?.[list]) ? doc[list] : []).find(r => r && r.id === id);
    if (hit) return { record: hit, type: type || String(hit.type || "item") };
  }
  return null;
}

export default function TwinItemWindow({ target, onClose }) {
  const { data, act, can } = useLabWindow();
  const doc = data.twin?.data || null;
  const found = doc ? findTwinRecord(doc, target.id) : null;
  if (!found) return <WindowShell kind="twin" name={target.id} state={{ word: doc ? "Not found" : "Loading…", tone: "unknown" }}
    can={{ operate: false, admin: false }} readOnlyText="Nothing to change" onClose={onClose}>
    <p role="status" className="lab-window-muted">{doc ? `No 3D record with id ${target.id}.` : "Loading the 3D data…"}</p>
  </WindowShell>;
  const { record, type } = found;
  const { linked, only } = classifyTwin(doc, liveForTwin(data));
  const link = linked.get(record.id) || null;
  const reason = only.find(o => o.id === record.id)?.reason || "";
  const [linkKind, ...rest] = link ? link.split(":") : [];
  const linkTarget = link ? { kind: linkKind, id: rest.join(":") } : null;
  return <WindowShell kind="twin" name={record.name || record.id} state={{ word: link ? "In Lab Manager" : reason || "3D only", tone: link ? "ok" : "unknown" }}
    badges={link ? [] : ["3D only"]} can={{ operate: false, admin: false }}
    readOnlyText={can.operate ? "3D records are edited in the 3D Twin for now" : "Viewer · read only"} onClose={onClose}
    facts={[type, record.id, record.status]}
    tools={<button type="button" className="lab-window-btn" onClick={() => act.goTo("twin", { ref: `id:${record.id}` })}>3D</button>}>
    <WindowSection title="Details" id="details">
      <dl className="lab-window-dl">
        <dt>Id</dt><dd>{record.id}</dd>
        <dt>Type</dt><dd>{record.typeLabel || type}</dd>
        <dt>Status</dt><dd>{record.status || "—"}</dd>
        <dt>Notes</dt><dd dir="auto">{record.notes || "—"}</dd>
      </dl>
      {linkTarget && <p className="mt-2"><button type="button" className="lab-window-link" onClick={() => act.open(linkTarget)}>Open it in Lab Manager</button></p>}
    </WindowSection>
  </WindowShell>;
}
