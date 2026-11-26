import type { EvalSummary } from "../types";

/** The live finding of the reasoning evaluation: one sentence, and where it comes from. */
export default function FindingsCard({ evaluation, onOpenMethod }: { evaluation: EvalSummary; onOpenMethod: () => void }) {
  return (
    <div data-findings className="border-b border-white/10 p-4">
      <p className="eyebrow mb-1.5">Finding</p>
      <p className="text-[16px] font-medium leading-snug text-slate-100">
        {evaluation.headline ?? "Not enough data yet for a clear finding."}
      </p>
      <button
        onClick={onOpenMethod}
        className="mt-2 text-xs font-medium text-slate-300 underline-offset-2 hover:text-white hover:underline"
      >
        How it's measured →
      </button>
    </div>
  );
}
