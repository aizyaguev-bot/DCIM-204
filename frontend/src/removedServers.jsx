import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { hiddenSet, loadRemoved } from "./api/removedServers.js";
import { useAccounts } from "./accounts.jsx";

// Servers an Admin removed from the lab, shared by every page (Racks, monitoring, lab display, owners, SSH, Locations).
// Pages filter with api/removedServers.js (withoutRemoved / isRemovedServer) against `hidden`. The list is read on
// start and after each sign-in, every 60 s, when the tab becomes visible and after a remove / restore (refresh, or the
// "dcim-removed-servers" window event). A failed read keeps the last list; before the first answer nothing is hidden.
const Removed = createContext({ hidden: new Set(), data: null, refresh: async () => null, loaded: false });
export const useRemovedServers = () => useContext(Removed);

const POLL_MS = 60000;

export function RemovedServersProvider({ children }) {
  const { user } = useAccounts();
  const [state, setState] = useState({ data: null, hidden: new Set(), loaded: false });
  const refresh = useCallback(async () => {
    const { data } = await loadRemoved();
    // An unchanged answer keeps the same state, so a poll re-renders nothing (the lab display must not redraw).
    setState(prev => {
      if (prev.loaded && JSON.stringify(prev.data) === JSON.stringify(data)) return prev;
      const hidden = hiddenSet(data);
      const same = prev.hidden.size === hidden.size && [...hidden].every(k => prev.hidden.has(k));
      return { data, hidden: same ? prev.hidden : hidden, loaded: true };
    });
    return data;
  }, []);
  useEffect(() => {
    const quiet = () => { refresh().catch(() => {}); };
    quiet();
    const timer = setInterval(() => { if (!document.hidden) quiet(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) quiet(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("dcim-removed-servers", quiet);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("dcim-removed-servers", quiet); };
  }, [refresh, user?.id]);   // read again after a sign-in (the first read may have been refused)
  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <Removed.Provider value={value}>{children}</Removed.Provider>;
}
