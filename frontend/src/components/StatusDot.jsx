export default function StatusDot({ status }) {
  const map = {
    online:  "bg-emerald-400 shadow-[0_0_8px_#34d399]",
    active:  "bg-emerald-400 shadow-[0_0_8px_#34d399]",
    warning: "bg-amber-400  shadow-[0_0_8px_#fbbf24]",
    offline: "bg-rose-500   shadow-[0_0_8px_#f43f5e]",
    idle:    "bg-zinc-500",
    empty:   "bg-zinc-700",
    unknown: "bg-zinc-600",
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${map[status] || "bg-zinc-500"}`} />;
}
