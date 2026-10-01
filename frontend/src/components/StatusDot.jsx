export default function StatusDot({ status, label = false }) {
  const map = {
    online:  "bg-[#76b900]",
    active:  "bg-[#76b900]",
    warning: "bg-amber-400",
    offline: "bg-[#fe3f3f]",
    idle:    "bg-zinc-500",
    empty:   "bg-zinc-700",
    unknown: "bg-zinc-600",
  };
  const text = status || "unknown";
  return <span className="inline-flex items-center gap-1.5 shrink-0"><span role="img" aria-label={text} title={text} className={`inline-block shrink-0 w-2 h-2 rounded-full ${map[status] || "bg-zinc-500"}`} />{label && <span className="text-xs font-normal text-zinc-400">{text[0].toUpperCase() + text.slice(1)}</span>}</span>;
}
