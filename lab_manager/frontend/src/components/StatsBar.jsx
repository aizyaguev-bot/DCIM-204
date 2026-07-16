export default function StatsBar({ stats }) {
  const items = [
    { label: "Devices",          value: stats.deviceCount },
    { label: "Outlets on",       value: `${stats.outletsOn} / ${stats.outletsTotal}` },
    { label: "Total draw",       value: `${(stats.watts / 1000).toFixed(2)} kW` },
    { label: "KVM ports up",     value: `${stats.portsActive} / ${stats.portsTotal}` },
    { label: "Alerts",           value: stats.alerts, danger: stats.alerts > 0 },
  ];
  return (
    <div className="border-b border-zinc-800/80 bg-zinc-950/40">
      <div className="max-w-[1600px] mx-auto px-6 py-3 flex flex-wrap gap-x-8 gap-y-2">
        {items.map(it => (
          <div key={it.label} className="flex items-baseline gap-2">
            <span className={`text-lg font-semibold tabular-nums ${it.danger ? "text-rose-400" : "text-zinc-100"}`}>{it.value}</span>
            <span className="text-xs uppercase tracking-wider text-zinc-500">{it.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
