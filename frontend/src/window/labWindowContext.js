// The window provider's context, kept apart from LabWindowProvider.jsx so window components can import the hook
// without importing the provider (which imports every window). See CONTRACT.md for the value.
import { createContext, useContext, useEffect } from "react";

const noop = () => {};
const EMPTY = Object.freeze({});
export const LabWindowContext = createContext({
  open: noop, openServer: noop, close: noop, current: null, index: null, twin: null, servers: [], data: EMPTY,
  ready: false, errors: EMPTY, reload: async () => {}, act: EMPTY, can: { operate: false, admin: false }, want: () => noop,
  lastChange: () => null, dismissLastChange: noop, dialog: null, closeDialog: noop, mounted: false,
});

// useLabWindow(): the provider's value (CONTRACT.md "useLabWindow").
export const useLabWindow = () => useContext(LabWindowContext);
// v1's name for the same hook (server windows).
export const useServerWindow = useLabWindow;

// A component that shows lab data (the Manage page, a ServerLink, a search box) asks the provider to load it while
// the component is mounted: "servers" (GET /api/devices/locations) or "all" (every store the windows read).
export function useLabData(level = "all") {
  const { want } = useContext(LabWindowContext);
  useEffect(() => want(level), [want, level]);
  return useContext(LabWindowContext);
}
