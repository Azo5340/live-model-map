import { fmt, METRIC_LABELS, STATUS, statusOf } from "../format";
import type { AIModel, EvalSummary, Metrics } from "../types";
import QualitySection from "./QualitySection";

/** Model details: name, status, the key numbers, and its reasoning scores. Nothing else. */
export default function SidePanel({
  model,
  evaluation,
  onClose,
}: {
  model: AIModel;
  evaluation: EvalSummary | null;
  onClose: () => void;
}) {
  const status = STATUS[statusOf(model)];
  const flagged = model.security?.issues.length ?? 0;
  const tiles: { label: string; value: string }[] = [
    ...(Object.keys(METRIC_LABELS) as (keyof Metrics)[])
      .filter((k) => model.metrics[k] != null)
      .map((k) => ({ label: METRIC_LABELS[k], value: fmt(model.metrics[k], k === "cost_per_1k_tokens" ? 4 : 1) })),
    ...(model.usage.download_count_24h != null
      ? [{ label: "Downloads/day", value: fmt(model.usage.download_count_24h) }]
      : []),
    ...(model.security?.scanned ? [{ label: "Security scan", value: flagged ? `${flagged} flagged` : "Clean" }] : []),
  ];

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-l border-white/10 bg-panel md:w-[360px]">
      <header className="flex items-start gap-3 p-5 pb-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[21px] font-semibold leading-tight tracking-tight">{model.name}</h2>
          <p className="mt-0.5 text-sm text-slate-400">{model.provider}</p>
          <span
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-0.5 text-xs"
            title={model.status_detail ?? undefined}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.color }} />
            {status.label}
          </span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close">
          ✕
        </button>
      </header>

      <section className="grid grid-cols-2 gap-2 px-5 pb-5 text-sm">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-white/10 px-3 py-2.5">
            <div className="text-[11px] text-slate-400">{t.label}</div>
            <div className="mt-0.5 text-[15px] font-semibold tabular-nums">{t.value}</div>
          </div>
        ))}
      </section>

      {evaluation && <QualitySection evaluation={evaluation} modelId={model.id} />}
    </aside>
  );
}
