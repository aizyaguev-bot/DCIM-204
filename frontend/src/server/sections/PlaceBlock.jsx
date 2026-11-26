// Place & ports (WP-1, v1 §1.3): the rack and floor or shelf ("(auto)" when Racks numbers it itself), every PDU outlet
// with its label, on/off, W and PDU IP, the KVM port with IN USE, "Shares floor N with …", and Show on Racks. Every
// role reads it; the changes are the action bar's (PlaceActions). The "Last change" panel is the window's own.
// Props: { record, can, act }.
import { WindowSection } from "../../window/WindowShell.jsx";
import { kvmPortText, outletText } from "../../window/format.js";
import { placeWord } from "../../components/racks/floors.js";
import { placeText } from "../serverRecord.js";

const STATE = { on: "On", off: "Off" };

export default function PlaceBlock({ record, act }) {
  const rack = record.drawn?.rack || record.rack;
  const d = record.drawn;
  const where = d?.rack && Number.isInteger(d.u) ? `${placeWord(d.rack)} ${d.u}` : "";
  return <WindowSection title="Place & ports" id="place">
    <dl className="lab-window-dl" data-place="">
      <dt>Place</dt>
      <dd dir="auto" data-place-text="">{placeText(record)}{d?.auto ? " (auto)" : ""}</dd>
      <dt>PDU</dt>
      <dd dir="auto" data-place-pdu="">{record.pdu.length ? <ul className="place-ports">{record.pdu.map(p => <li key={`${p.device_id}:${p.port}`}>
        {[outletText(p), p.label || null, STATE[p.state] || "State unknown", p.watts != null ? `${p.watts} W` : null, p.pduIp || null].filter(Boolean).join(" · ")}
      </li>)}</ul> : "No PDU outlet"}</dd>
      <dt>KVM</dt>
      <dd dir="auto" data-place-kvm="">{record.kvm.length ? <ul className="place-ports">{record.kvm.map(p => <li key={`${p.device_id}:${p.port}`}>
        {[kvmPortText(p), p.label || null].filter(Boolean).join(" · ")}{p.inUse ? <strong className="place-in-use"> · IN USE</strong> : null}
      </li>)}</ul> : "No KVM port"}</dd>
      {record.floorShared.length > 0 && <>
        <dt>Shared</dt>
        <dd dir="auto" data-place-shared="">Shares {where || "the floor"} with {record.floorShared.join(", ")}</dd>
      </>}
    </dl>
    {!record.pdu.length && <p className="lab-window-muted mt-2">Without a PDU outlet it is not drawn on Racks.</p>}
    {rack && <p className="mt-2"><button type="button" className="lab-window-link" data-action="show-on-racks" onClick={() => act.showOnRacks(rack)}>Show on Racks</button></p>}
  </WindowSection>;
}
