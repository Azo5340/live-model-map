import { BADGE, fmt, isUnderrated, pct, underratedThreshold } from "../format";
import type { EvalScore, EvalSummary } from "../types";

const score = (s: EvalScore) => `${pct(s.k / s.n)}  (${pct(s.lo)}–${pct(s.hi)})`;

/** The model panel's reasoning scores. Explanations live in the "How it's measured" dialog. */
export default function QualitySection({ evaluation, modelId }: { evaluation: EvalSummary; modelId: string }) {
  const e = evaluation.models[modelId];
  const underrated = isUnderrated(e, underratedThreshold(evaluation.models));
  return (
    <section className="border-t border-white/10 px-5 py-4 text-sm">
      <h3 className="eyebrow mb-2.5">Reasoning</h3>
      {!e?.known ? (
        <p className="text-slate-400">Not tested yet</p>
      ) : (
        <dl className="space-y-1.5">
          <Row label="Known problems" value={score(e.known)} />
          {e.modified && <Row label="New numbers" value={score(e.modified)} />}
          {e.drop && <Row label="Drop" value={`${Math.round(100 * e.drop.mean)} pts`} />}
          {e.claimed_gsm8k != null && <Row label="Authors claim" value={pct(e.claimed_gsm8k)} />}
          {e.quality && <Row label="Score" value={fmt(Math.round(e.quality.value))} />}
        </dl>
      )}
      {(e?.memorises || underrated) && (
        <div className="mt-3 flex gap-2 text-xs">
          {e?.memorises && <Flag color={BADGE.memorises}>Drops on new numbers</Flag>}
          {underrated && <Flag color={BADGE.underrated}>Underrated</Flag>}
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className="whitespace-pre text-right tabular-nums text-slate-100">{value}</dd>
    </div>
  );
}

function Flag({ color, children }: { color: string; children: string }) {
  return (
    <span className="inline-flex items-center rounded-full border px-2.5 py-0.5" style={{ borderColor: color, color }}>
      {children}
    </span>
  );
}
