import { ago } from "../format";
import type { EvalSummary } from "../types";

/** The live finding of the reasoning evaluation, at the top of the left column. */
export default function FindingsCard({ evaluation, onOpenMethod }: { evaluation: EvalSummary; onOpenMethod: () => void }) {
  const tested = Object.values(evaluation.models).filter((e) => e.known).length;
  const p = evaluation.popularity;
  return (
    <div data-findings className="border-b border-slate-800 p-3 text-xs leading-snug">
      <p className="mb-1 font-medium uppercase tracking-wide text-slate-500">Finding</p>
      <p className="text-sm text-slate-100">{evaluation.headline ?? "Not enough data yet for a clear finding."}</p>
      {p && (
        <p className="mt-1 text-slate-400">
          Downloads vs reasoning: ρ = {p.spearman.toFixed(2)} ({p.lo.toFixed(2)} to {p.hi.toFixed(2)}, {p.n} models)
        </p>
      )}
      <p className="mt-1 text-slate-500">
        {tested} models tested · ${evaluation.spent_usd.toFixed(2)} of ${evaluation.budget_usd.toFixed(0)} spent ·{" "}
        {ago(evaluation.generated_at)}
      </p>
      <button onClick={onOpenMethod} className="mt-1 text-slate-300 underline-offset-2 hover:underline">
        How it's measured
      </button>
    </div>
  );
}
