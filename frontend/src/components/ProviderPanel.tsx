import { useMemo } from "react";
import { fmt, STATUS, statusOf } from "../format";
import type { AIModel, ModelStatus, Providers } from "../types";

const SEVERITY: ModelStatus[] = ["security_incident", "down", "degraded", "operational", "unknown"];

/** Details for a provider: logo, overall status, totals and its models (clickable). */
export default function ProviderPanel({
  provider,
  models,
  providers,
  onSelect,
  onClose,
}: {
  provider: string;
  models: Map<string, AIModel>;
  providers: Providers;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const own = useMemo(
    () =>
      [...models.values()]
        .filter((m) => m.provider === provider)
        .sort((a, b) => (b.usage.download_count_24h ?? 0) - (a.usage.download_count_24h ?? 0)),
    [models, provider],
  );
  const counts = useMemo(() => {
    const c = Object.fromEntries(SEVERITY.map((s) => [s, 0])) as Record<ModelStatus, number>;
    for (const m of own) c[statusOf(m)]++;
    return c;
  }, [own]);
  const worst = SEVERITY.find((s) => counts[s] > 0) ?? "unknown";
  const downloads = own.reduce((sum, m) => sum + (m.usage.download_count_24h ?? 0), 0);
  const elo = own.map((m) => m.metrics.elo_score).filter((v): v is number => v != null);
  const avatar = providers[provider]?.avatar;

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-l border-white/5 bg-[#0C1328] md:w-[380px]">
      <header className="flex items-center gap-3 border-b border-white/5 p-4">
        {avatar ? (
          <img src={avatar} alt="" className="h-11 w-11 shrink-0 rounded-full bg-white object-cover" />
        ) : (
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-slate-800 text-sm font-semibold text-slate-300">
            {provider.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{provider}</h2>
          <div
            className="mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ color: STATUS[worst].color, background: `${STATUS[worst].color}22` }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS[worst].color }} />
            {worst === "operational" ? "All served models operational" : `Worst status: ${STATUS[worst].label}`}
          </div>
        </div>
        <button onClick={onClose} className="self-start text-slate-400 hover:text-white" aria-label="Close">
          ✕
        </button>
      </header>

      <section className="grid grid-cols-2 gap-2 p-4 text-sm">
        <div className="rounded-lg bg-slate-800/60 px-3 py-2">
          <div className="text-[11px] text-slate-400">Models on the map</div>
          <div className="tabular-nums">{own.length}</div>
        </div>
        <div className="rounded-lg bg-slate-800/60 px-3 py-2">
          <div className="text-[11px] text-slate-400">Downloads / day (30-day avg.)</div>
          <div className="tabular-nums">{fmt(downloads)}</div>
        </div>
        {elo.length > 0 && (
          <div className="rounded-lg bg-slate-800/60 px-3 py-2">
            <div className="text-[11px] text-slate-400">Best ELO (LMArena)</div>
            <div className="tabular-nums">{fmt(Math.max(...elo))}</div>
          </div>
        )}
        <div className="col-span-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
          {SEVERITY.filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS[s].color }} />
              {counts[s]} {STATUS[s].label.toLowerCase()}
            </span>
          ))}
        </div>
      </section>

      <section className="border-t border-white/5 p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Models</h3>
        <ul className="space-y-0.5">
          {own.map((m) => (
            <li key={m.id}>
              <button
                onClick={() => onSelect(m.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS[statusOf(m)].color }} />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-slate-500">
                  {fmt(m.usage.download_count_24h)}/day
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
