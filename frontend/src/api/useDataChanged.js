import { useEffect, useRef } from "react";
import { EVENT } from "./changes.js";

// Calls onChange(domainsThatChanged) when the live change feed (./changes.js) reports a change in any of `domains`
// (an array of domain names, or "*" for every change). The latest onChange is used; no re-subscribe per render.
export function useDataChanged(domains, onChange) {
  const ref = useRef(onChange);
  ref.current = onChange;
  const key = domains === "*" ? "*" : [...domains].sort().join(",");
  useEffect(() => {
    const wanted = key === "*" ? null : new Set(key.split(","));
    const listener = e => {
      const hit = (e.detail?.domains || []).filter(d => !wanted || wanted.has(d));
      if (hit.length) ref.current?.(hit);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [key]);
}
