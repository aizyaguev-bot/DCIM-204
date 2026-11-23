// STUB (WP-0, read-only). WP-3 replaces it: MonitorDetails + TargetSettings (Operator), "Monitor this server", and the
// timeline (incidents, removal log for Admin, unit moves, this session's changes). Props: { record, can, act }.
// Rendered only while the collapsible Activity block is open, so it may load its own data on mount.
export default function ActivitySection({ record }) {
  const m = record.monitor;
  return <p className="lab-window-muted" dir="auto">
    {m ? `Ping monitor: ${m.status}${m.host ? ` (${m.host})` : ""}.` : "This server has no ping monitor."}
  </p>;
}
