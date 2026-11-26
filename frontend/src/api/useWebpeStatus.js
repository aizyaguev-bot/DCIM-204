import { useEffect, useState } from "react";
import { loadWebpeStatus, POLL_MS } from "./webpeStatus.js";

// The latest status (null until read, or when it cannot be read): read now, then every 30 s while the page is visible,
// and again when it becomes visible after 30 s or more.
export function useWebpeStatus(enabled = true) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true, last = 0;
    const read = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      last = Date.now();
      try { const data = await loadWebpeStatus(); if (alive) setStatus(data); }
      catch { if (alive) setStatus(null); }
    };
    const visible = () => { if (document.visibilityState === "visible" && Date.now() - last >= POLL_MS) read(); };
    read();
    const timer = setInterval(read, POLL_MS);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [enabled]);
  return status;
}
