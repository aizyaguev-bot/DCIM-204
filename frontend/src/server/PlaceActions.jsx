// STUB (WP-0). WP-1 replaces the body: Swap with… / Move to… in the bar; Pin, Take over, Choose ports, Clear location
// in ⋯ More; MoveDialog, PortsMoveDialog and ClearLocationDialog. Keep the export shape (window/CONTRACT.md):
//   Bar({ record, can, act })                      buttons for the action bar (rendered only when can.operate)
//   more({ record, can, act }) -> [MenuItem]       plain function, no hooks
//   Dialogs({ dialog, record, can, act, close })   renders this package's dialog when dialog.type is in dialogTypes
//   dialogTypes                                     the act.openDialog types this package owns
// act.openMove({ mode, swapWith, moveTo }) opens dialog { type: "move", mode, swapWith, moveTo }; act.openPorts() and
// act.openClear() open { type: "ports" } and { type: "clear" }.

function Bar() {
  return null;
}

function more() {
  return [];
}

function Dialogs() {
  return null;
}

export default { Bar, more, Dialogs, dialogTypes: ["move", "ports", "clear"] };
