// The Racks page's server order (GET /api/rack-positions, a public read): { rack: [DCIM id] }. On a floor that several
// servers share, a unit takes the owner of the first of them in this order, then by name, exactly as Racks
// (unitOwner.js floorServer over buildRackRows) and the 3D twin pick it (unitModel.js floorServer). Reloaded when the
// change feed reports a "layout" change; until it has loaded (or when it fails) the order is by name.
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveReload } from "../api/useLiveReload.js";

export function useRackOrder() {
  const [order, setOrder] = useState(null);
  const live = useRef(true);
  const turn = useRef(0);
  const load = useCallback(async () => {
    const mine = ++turn.current;
    try {
      const response = await fetch("/api/rack-positions", { cache: "no-store" });
      if (!response.ok) return;
      const doc = await response.json();
      if (live.current && mine === turn.current) setOrder(doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {});
    } catch { /* keeps the order it has */ }
  }, []);
  useEffect(() => {
    live.current = true;
    load();
    return () => { live.current = false; };
  }, [load]);
  useLiveReload(["layout"], load);
  return order;
}
