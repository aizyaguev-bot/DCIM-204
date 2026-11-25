// Power for a whole server or one of its feeds, shared by every server window (and by Racks from WP-5 on). One copy
// lives in the window provider. Every request asks first through PowerConfirmDialog, Power on included, whatever the
// account's confirm_power says; the plan is checked again against the latest PDU readings before anything switches
// (the Racks rule, DcimView requestPower/runPower).
//
// useServerPower({ devices, pduStatuses, maintenance, switchFeeds, canOperate, toast, conflicts }) ->
//   { enabled, groupFor(name), pending(key), request(name, action, opener, { scope, feedId }), blocked(name, scope), element }
//   request returns false when nothing can be asked (Viewer, or no PDU outlet names the server).
//   element: the open PowerConfirmDialog (or null); the provider renders it.
//   switchFeeds(targets, action, { stopOnFailure }) is App's: it switches the outlets in order and reports each.
//
// v3 shelves (CONTRACT.md §11, spec §7.11): conflicts is a Map key -> { key, name, places } of the servers whose name is
// on outlets of more than one shelf seat (api/shelves.js placeConflicts; the provider passes it). For such a server
// whole-server power (scope "server") is off everywhere this hook is used (the server window and the Racks pill):
//   - blocked(name, scope = "server") is the reason ("Its outlets are on two floors; switch single outlets from the PDU
//     window.", api/shelves.js placePowerBlock), or null;
//   - groupFor(name) gives the group with placeConflict and wholeServerBlocked (that reason), for the menus;
//   - request(name, action, opener, { scope: "server" }) opens no confirmation: it shows the reason as an error toast and
//     answers "blocked";
//   - the switch itself checks again on the latest map and refuses ("… — nothing was switched.").
// One outlet (scope "feed") stays switchable. Without the shelf backend conflicts is empty: nothing changes.
import { createElement, useCallback, useMemo, useRef, useState } from "react";
import { serverIdentity } from "../api/locations.js";
import { conflictOf, placePowerBlock, withPlaceConflict } from "../api/shelves.js";
import PowerConfirmDialog from "../components/racks/PowerConfirmDialog.jsx";
import { planServerPower, sameTargets, serverDisplayName, serverPowerGroup } from "../components/racks/serverPower.js";

// The toast after a power request: what was switched, or which outlets were not.
export function powerResultText(serverName, action, results, { scope = "server", group = null } = {}) {
  const server = serverDisplayName(serverName);
  const failed = (results || []).filter(r => !r.ok);
  const done = (results || []).filter(r => r.ok);
  const where = done.map(r => `${r.pduName} · outlet ${r.outlet}`).join(", ");
  if (failed.length) return { tone: "error", text: `Some outlets of ${server} were not switched: ${failed.map(r => `${r.pduName} outlet ${r.outlet}${r.error ? ` (${r.error})` : ""}`).join(", ")}.` };
  const switched = new Set(done.map(r => `${r.pduId}:${r.outlet}`));
  const powered = scope === "feed" && action !== "on" ? (group?.feeds || []).filter(f => !switched.has(f.id) && f.state === "on") : [];
  if (powered.length && done.length === 1) {
    const still = powered.map(f => `${f.pduName} · outlet ${f.outlet}`).join(", ");
    return { tone: "ok", text: action === "cycle"
      ? `${done[0].label} was power-cycled (${where}); ${server} stayed powered by ${still}, so it was not power-cycled.`
      : `${done[0].label} is off (${where}); ${server} is still powered by ${still}.` };
  }
  return { tone: "ok", text: `${server} is ${action === "cycle" ? "power-cycled" : action} (${where}).` };
}

export function useServerPower({ devices, pduStatuses, maintenance, switchFeeds, canOperate, toast, conflicts = null }) {
  const ctx = useMemo(() => ({ devices, pduStatuses, maintenance }), [devices, pduStatuses, maintenance]);
  const latest = useRef(ctx);
  latest.current = ctx;
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;
  const [pendingMap, setPendingMap] = useState({});
  const [dialog, setDialog] = useState(null);
  const enabled = !!canOperate && typeof switchFeeds === "function";

  const groupFor = useCallback(name => withPlaceConflict(serverPowerGroup(name, ctx), conflictOf(conflicts, serverIdentity(name))), [ctx, conflicts]);
  const pending = useCallback(key => pendingMap[key] || null, [pendingMap]);
  // Why a request for this server is refused before it is asked (v3: whole-server power of a server on two seats).
  const blocked = useCallback((name, scope = "server") => placePowerBlock(conflictOf(conflicts, serverIdentity(name)), scope), [conflicts]);

  const run = useCallback(async ({ serverName, action, scope, feedId, plan }) => {
    if (!enabled) throw new Error("Viewer account: read only");
    const placeBlock = placePowerBlock(conflictOf(conflictsRef.current, serverIdentity(serverName)), scope);
    if (placeBlock) throw new Error(`${placeBlock} — nothing was switched.`);
    const fresh = planServerPower(serverPowerGroup(serverName, latest.current), action, scope, feedId);
    if (fresh.disabledReason) throw new Error(`${fresh.disabledReason} — nothing was switched.`);
    if (!sameTargets(plan, fresh)) throw new Error("The outlet mapping changed while the dialog was open — nothing was switched.");
    const key = serverIdentity(serverName);
    setPendingMap(p => ({ ...p, [key]: action }));
    try { return await switchFeeds(fresh.targets, action, { stopOnFailure: action === "off" }); }
    finally { setPendingMap(p => { const next = { ...p }; delete next[key]; return next; }); }
  }, [enabled, switchFeeds]);

  const request = useCallback((name, action, opener = null, { scope = "server", feedId = null } = {}) => {
    const group = serverPowerGroup(name, latest.current);
    if (!group || !enabled) return false;
    const placeBlock = placePowerBlock(conflictOf(conflictsRef.current, group.key), scope);
    if (placeBlock) { toast?.(`${serverDisplayName(name)}: ${placeBlock}`, { tone: "error" }); return "blocked"; }
    setDialog({ serverName: name, key: group.key, snapshot: group, action, scope, feedId: feedId || group.feeds[0]?.id || null,
      allowScopeChoice: group.feeds.length > 1 && scope === "server", opener });
    return true;
  }, [enabled, toast]);

  const groupNow = dialog ? serverPowerGroup(dialog.serverName, ctx) || dialog.snapshot : null;
  const element = dialog ? createElement(PowerConfirmDialog, {
    key: `${dialog.key}:${dialog.action}:${dialog.scope}`,
    serverName: dialog.serverName, group: groupNow, action: dialog.action, scope: dialog.scope, feedId: dialog.feedId,
    allowScopeChoice: dialog.allowScopeChoice,
    onConfirm: ({ action, scope, feedId, plan }) => run({ serverName: dialog.serverName, action, scope, feedId, plan }),
    onClose: (done, results, action, scope) => {
      const name = dialog.serverName;
      setDialog(null);
      if (done) { const { text, tone } = powerResultText(name, action, results, { scope, group: groupNow }); toast?.(text, { tone }); }
    },
  }) : null;

  return { enabled, groupFor, pending, request, blocked, element };
}
