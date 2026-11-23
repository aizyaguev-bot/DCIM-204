// STUB (WP-0, read-only). WP-1 replaces it: Place & ports (rack and floor, "(auto)", every PDU outlet with label,
// on/off, W and PDU IP, the KVM port with IN USE, "Shares floor N with …", Show on Racks) and the Last change panel.
// Props: { record, can, act }.
import { WindowSection } from "../../window/WindowShell.jsx";
import { placeText } from "../serverRecord.js";
import { kvmPortText, outletText } from "../../window/format.js";

export default function PlaceBlock({ record, act }) {
  const rack = record.drawn?.rack || record.rack;
  return <WindowSection title="Place & ports" id="place">
    <dl className="lab-window-dl">
      <dt>Place</dt><dd dir="auto">{placeText(record)}{record.drawn?.auto ? " (auto)" : ""}</dd>
      <dt>PDU</dt><dd dir="auto">{record.pdu.length ? record.pdu.map(outletText).join(", ") : "None"}</dd>
      <dt>KVM</dt><dd dir="auto">{record.kvm.length ? record.kvm.map(p => `${kvmPortText(p)}${p.inUse ? " (IN USE)" : ""}`).join(", ") : "None"}</dd>
      {record.floorShared.length > 0 && <><dt>Shared</dt><dd dir="auto">Shares the floor with {record.floorShared.join(", ")}</dd></>}
    </dl>
    {rack && <p className="mt-2"><button type="button" className="lab-window-link" onClick={() => act.showOnRacks(rack)}>Show on Racks</button></p>}
  </WindowSection>;
}
