import { ago } from "../format";
import type { EvalSummary } from "../types";

const signed = (x: number) => x.toFixed(2).replace("-", "−");

/** Plain-English reading of the rank correlation between downloads and reasoning. */
function verdict(p: NonNullable<EvalSummary["popularity"]>): string {
  if (p.lo <= 0 && p.hi >= 0) return "No clear link between downloads and reasoning.";
  return p.spearman > 0
    ? "More downloaded models tend to reason better."
    : "More downloaded models tend to reason worse.";
}

/** The live finding of the reasoning evaluation, at the top of the left column. */
export default function FindingsCard({ evaluation, onOpenMethod }: { evaluation: EvalSummary; onOpenMethod: () => void }) {
  const tested = Object.values(evaluation.models).filter((e) => e.known).length;
  const p = evaluation.popularity;
  return (
    <div data-findings className="border-b border-slate-800 p-3 text-xs leading-snug">
      <p className="eyebrow mb-1.5">Finding</p>
      <p className="font-serif text-[17px] leading-snug text-slate-100">{evaluation.headline ?? "Not enough data yet for a clear finding."}</p>
      {p && (
        <p className="mt-1.5 text-slate-300">
          {verdict(p)}{" "}
          <span className="text-slate-400">
            Rank correlation ρ = {signed(p.spearman)} (95% CI {signed(p.lo)} to {signed(p.hi)}, {p.n} models).
          </span>
        </p>
      )}
      <p className="mt-1.5 text-slate-400">
        {tested} models tested · ${evaluation.spent_usd.toFixed(2)} of ${evaluation.budget_usd.toFixed(2)} spent · updated{" "}
        {ago(evaluation.generated_at)}
      </p>
      <button
        onClick={onOpenMethod}
        className="mt-1.5 font-medium text-brass underline-offset-2 hover:underline focus-visible:underline"
      >
        How it's measured →
      </button>
    </div>
  );
}
