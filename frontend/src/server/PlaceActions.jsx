// Place & ports actions of the server window (WP-1, v1 §1.1 and §1.7). The export shape is window/CONTRACT.md's:
//   Bar({ record, can, act })                      Swap with… and Move to… (rendered only when can.operate)
//   more({ record, can, act }) -> [MenuItem]       Pin to floor N (auto-placed only), Take over a place…, Choose ports…,
//                                                  Clear location… (a plain function, no hooks)
//   Dialogs({ dialog, record, can, act, close })   MoveDialog, PortsMoveDialog, ClearLocationDialog
//   dialogTypes                                     ["move", "ports", "clear"]
// act.openMove({ mode, swapWith, moveTo }) opens dialog { type: "move", key, mode, swapWith, moveTo }; act.openPorts()
// and act.openClear() open { type: "ports" } and { type: "clear" }. Every change is a dry run first, applied with its
// plan_revision; the PDU and KVM devices never move.
import { placeWord, validFloor } from "../components/racks/floors.js";
import MoveDialog from "./MoveDialog.jsx";
import PortsMoveDialog from "./PortsMoveDialog.jsx";
import ClearLocationDialog from "./ClearLocationDialog.jsx";

function Bar({ can, act }) {
  if (!can?.operate) return null;
  return <>
    <button type="button" className="lab-window-btn" data-action="swap-with" onClick={() => act.openMove({ mode: "swap" })}>Swap with…</button>
    <button type="button" className="lab-window-btn" data-action="move-to" onClick={() => act.openMove({ mode: "move" })}>Move to…</button>
  </>;
}

function more({ record, can, act }) {
  if (!can?.operate || !record) return [];
  const items = [];
  const d = record.drawn;
  if (d?.auto && validFloor(d.u, d.rack)) {
    items.push({ id: "pin", label: `Pin to ${placeWord(d.rack)} ${d.u}`,
      title: `It is on ${placeWord(d.rack)} ${d.u} only because that is the next free one; pin it there`,
      onSelect: () => act.openMove({ mode: "pin" }) });
  }
  const ports = record.pdu.length + record.kvm.length;
  items.push(
    { id: "take-over", label: "Take over a place…", onSelect: () => act.openMove({ mode: "takeover" }) },
    { id: "choose-ports", label: "Choose ports…", onSelect: () => act.openPorts() },
    { id: "clear-location", label: "Clear location…", disabled: !ports, title: ports ? undefined : "It has no PDU outlet or KVM port to clear",
      onSelect: () => act.openClear() },
  );
  return items;
}

function Dialogs({ dialog, record, can, act, close }) {
  if (!dialog || !can?.operate) return null;
  // A new mode or target (Swap with X instead, a second act.openMove) starts a fresh dialog.
  if (dialog.type === "move") return <MoveDialog key={`${dialog.mode || "move"}:${dialog.swapWith || ""}`} dialog={dialog} record={record} act={act} close={close}/>;
  if (dialog.type === "ports") return <PortsMoveDialog record={record} act={act} close={close}/>;
  if (dialog.type === "clear") return <ClearLocationDialog record={record} act={act} close={close}/>;
  return null;
}

export default { Bar, more, Dialogs, dialogTypes: ["move", "ports", "clear"] };
