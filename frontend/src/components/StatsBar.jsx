export default function StatsBar({ stats }) {
  const items = [
    { label: "Devices",      value: stats.deviceCount },
    { label: "Outlets on",   value: `${stats.outletsOn} / ${stats.outletsTotal}` },
    { label: "Total draw",   value: `${(stats.watts / 1000).toFixed(2)} kW` },
    { label: "KVM ports up", value: `${stats.portsActive} / ${stats.portsTotal}` },
    { label: "Alerts",       value: stats.alerts, danger: stats.alerts > 0 },
  ];

  const tempLabel = stats.tempMin === stats.tempMax
    ? `${stats.tempMin}°C`
    : `${stats.tempMin}–${stats.tempMax}°C`;
  const humLabel = stats.humMin === stats.humMax
    ? `${stats.humMin}%`
    : `${stats.humMin}–${stats.humMax}%`;

  const tempDanger = stats.tempMax != null && stats.tempMax > 35;
  const tempWarn   = !tempDanger && stats.tempMax != null && stats.tempMax > 24;
  const humWarn    = stats.humMax != null && stats.humMax > 70;

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-950/40">
      <div className="max-w-[1600px] mx-auto px-6 py-3 flex flex-wrap items-center gap-x-8 gap-y-2">
        {items.map(it => (
          <div key={it.label} className="flex items-baseline gap-2">
            <span className={`text-lg font-semibold tabular-nums ${it.danger ? "text-rose-400" : "text-zinc-100"}`}>{it.value}</span>
            <span className="text-xs uppercase tracking-wider text-zinc-500">{it.label}</span>
          </div>
        ))}

        {stats.hasSensors && (
          <>
            <div className="w-px h-5 bg-zinc-800 hidden sm:block"/>
            {stats.tempMin != null && (
              <div className="flex items-center gap-1.5">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={tempDanger ? "text-rose-400" : tempWarn ? "text-amber-400" : "text-zinc-400"}>
                  <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
                </svg>
                <span className={`text-lg font-semibold tabular-nums ${tempDanger ? "text-rose-400" : tempWarn ? "text-amber-400" : "text-zinc-100"}`}>
                  {tempLabel}
                </span>
                <span className="text-xs uppercase tracking-wider text-zinc-500">Temp</span>
              </div>
            )}
            {stats.humMin != null && (
              <div className="flex items-center gap-1.5">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={humWarn ? "text-amber-400" : "text-zinc-400"}>
                  <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
                </svg>
                <span className={`text-lg font-semibold tabular-nums ${humWarn ? "text-amber-400" : "text-zinc-100"}`}>
                  {humLabel}
                </span>
                <span className="text-xs uppercase tracking-wider text-zinc-500">Humidity</span>
              </div>
            )}
            {stats.leakDetected && (
              <div className="flex items-center gap-1.5 animate-pulse">
                <span className="text-rose-400 text-lg font-bold">⚠</span>
                <span className="text-sm font-semibold text-rose-400">Leak detected</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
