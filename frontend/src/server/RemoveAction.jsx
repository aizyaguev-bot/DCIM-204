// STUB (WP-0). WP-2 replaces the body: the removed / deleted banner with Restore (Admin), wired to act.openDelete and
// the restore endpoints. Delete… itself is placed by WindowShell (deleteTarget). Export shape: window/CONTRACT.md:
//   more({ record, can, act }) -> [MenuItem]
//   Banner({ record, can, act }) -> element | null   shown under the header
import { formatTime } from "../window/format.js";

function more() {
  return [];
}

function Banner({ record }) {
  if (!record?.removed) return null;
  const { record: removed, active } = record.removed;
  // The time and who are unknown until the removal list has loaded (the /locations flag came first).
  const when = formatTime(removed?.removed_at);
  const at = when ? ` ${when}` : "";
  if (!active) return <div className="lab-window-banner" data-tone="warn" role="status">
    Removed{at}, but its name is on new ports now, so it shows again.
  </div>;
  return <div className="lab-window-banner" role="status">
    Removed from the lab{at}{removed?.removed_by ? ` by ${removed.removed_by}` : ""}. Read only.
  </div>;
}

export default { more, Banner };
