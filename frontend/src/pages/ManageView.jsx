// STUB (WP-0): the Manage page (?tab=inventory, label "Manage"). Until WP-M builds it (v2 §M: one table of every kind,
// filters in the URL, bulk select, Deleted view) it renders today's Inventory server table through
// DcimView section="inventory". Props: exactly DcimView's (App passes the same props it gives Racks); WP-M may drop
// the ones it does not need.
import DcimView from "./DcimView.jsx";

export default function ManageView(props) {
  return <DcimView {...props} section="inventory"/>;
}
