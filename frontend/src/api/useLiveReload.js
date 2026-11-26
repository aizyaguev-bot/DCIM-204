import { useMemo, useRef } from "react";
import { useDataChanged } from "./useDataChanged.js";
import { createLiveReload } from "./liveReload.js";

// A view's live reload: reload(domainsThatChanged) runs when the change feed reports one of `domains` ("*" = any),
// coalesced by createLiveReload (one at a time, never during this view's own save). Returns { trigger, during, flush }:
// wrap the view's saves in during(() => save()) and call flush() when something blocked() was waiting for is over.
export function useLiveReload(domains, reload, { blocked } = {}) {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const live = useMemo(() => createLiveReload(d => reloadRef.current?.(d), { isBlocked: () => !!blockedRef.current?.() }), []);
  useDataChanged(domains, live.trigger);
  return live;
}
