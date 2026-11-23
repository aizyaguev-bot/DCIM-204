// STUB (WP-0). WP-D builds the one delete dialog (v2 §D.2): dry run of POST /api/lab/delete, grouped preview (Will be
// deleted / Also changes / Blocked / Where it disappears), options, reason, confirm by name or count, apply with
// plan_revision, then the provider toast "Deleted N items · Undo". Until then a single server target uses today's
// RemoveServerDialog (Admin "Remove from lab"); anything else says it is not available yet.
// Props: { targets: [{ kind, id }], options?: {}, onClose(), onDone(result) }   z-[60], data-dialog="delete"
import RemoveServerDialog from "../components/racks/RemoveServerDialog.jsx";
import StubDialog from "../window/StubDialog.jsx";

export default function DeleteDialog({ targets = [], onClose, onDone }) {
  if (targets.length === 1 && targets[0]?.kind === "server") {
    return <RemoveServerDialog serverName={targets[0].id} onClose={onClose} onRemoved={result => onDone?.(result)}/>;
  }
  return <StubDialog id="delete" title={`Delete ${targets.length === 1 ? targets[0]?.id : `${targets.length} items`}`}
    text="Deleting this kind of item is not available yet." onClose={onClose}/>;
}
