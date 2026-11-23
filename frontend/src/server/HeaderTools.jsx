// STUB (WP-0): only "3D" (every role). WP-3 adds Console (Operator, when a KVM port is known; asks when the port is IN
// USE: act.openConsole(kvmPort)) and SSH (Operator, SshButton, its status read fresh). Props: { record, can, act }.
// Rendered in the window header before ×.
export default function HeaderTools({ record, act }) {
  if (!record || record.missing) return null;
  return <button type="button" className="lab-window-btn" title={`Show ${record.name} in 3D`} onClick={() => act.showIn3d()}>3D</button>;
}
