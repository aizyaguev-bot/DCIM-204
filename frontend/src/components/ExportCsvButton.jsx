import { useState } from "react";
import { api } from "../api/client";
import { useAccounts } from "../accounts";

// The one "Export CSV" button (Admin > Connections and Admin > Locations): downloads GET /api/devices/connections.csv,
// every server with its rack, U slot, IP, owner, ping and PDU outlets / KVM ports. The export is Operator+ (it holds
// addresses), so a Viewer sees the button disabled. onError(error) gets a failure, onError(null) a new attempt.
export default function ExportCsvButton({ disabled = false, onError }) {
  const { canOperate } = useAccounts();
  const [busy, setBusy] = useState(false);

  async function exportCsv() {
    setBusy(true);
    onError?.(null);
    try {
      const { blob, filename } = await api.downloadConnectionsCsv();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      onError?.(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={exportCsv} disabled={!canOperate || busy || disabled}
      title={canOperate ? "Download every server with its rack, U slot, IP, owner, PDU outlets and KVM ports as a CSV file"
        : "Operator role needed to export"}
      className="bg-nv-400 hover:bg-nv-300 text-zinc-950 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap disabled:opacity-50">
      {busy ? "Exporting…" : "Export CSV"}
    </button>
  );
}
