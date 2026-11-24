import { BADGE } from "../format";
import type { EvalScore, EvalSummary } from "../types";

const MAX_TIES = 6;
const pct = (x: number) => `${Math.round(100 * x)} %`;
const score = (s: EvalScore) => `${s.k}/${s.n} (${pct(s.lo)}–${pct(s.hi)})`;

/** The model panel's reasoning section: measured scores, claimed score, Arena, combined score, ties. */
export default function QualitySection({
  evaluation,
  modelId,
  arenaRating,
  onSelect,
}: {
  evaluation: EvalSummary;
  modelId: string;
  arenaRating: number | null;
  onSelect: (id: string) => void;
}) {
  const e = evaluation.models[modelId];
  return (
    <section className="border-t border-slate-800 p-4 text-sm">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Reasoning</h3>
      {!e || !e.known ? (
        <p className="text-slate-400">
          Not tested yet.
          {e?.quality ? ` Quality from LMArena only: ${Math.round(e.quality.value)}.` : ""}
        </p>
      ) : (
        <dl className="space-y-1.5">
          <Row label="Known problems" value={score(e.known)} />
          {e.modified && <Row label="Same problems, new numbers" value={score(e.modified)} />}
          {e.drop && (
            <Row
              label="Drop"
              value={`${Math.round(100 * e.drop.mean)} points (${Math.round(100 * e.drop.lo)} to ${Math.round(100 * e.drop.hi)})`}
            />
          )}
          {e.memorises && (
            <p className="text-xs" style={{ color: BADGE.memorises }}>
              Does clearly worse when only the numbers change: it may have seen the original problems.
            </p>
          )}
          {e.truncated > 0 && (
            <p className="text-xs text-slate-500">{e.truncated} answer(s) cut off at the length limit, counted as wrong.</p>
          )}
        </dl>
      )}
      {e && (
        <dl className="mt-3 space-y-1.5">
          {e.claimed_gsm8k != null && <Row label="Authors claim (GSM8K)" value={pct(e.claimed_gsm8k)} />}
          {arenaRating != null && <Row label="LMArena rating" value={String(Math.round(arenaRating))} />}
          {e.quality && (
            <Row
              label={evaluation.scale === "arena" ? "Combined score" : "Measured score"}
              value={
                Math.round(e.quality.value) +
                (e.quality.lo != null && e.quality.hi != null
                  ? ` (${Math.round(e.quality.lo)}–${Math.round(e.quality.hi)})`
                  : "")
              }
            />
          )}
          {e.underrated != null && e.underrated > 0 && e.quality && (
            <p className="text-xs" style={{ color: BADGE.underrated }}>
              Scores {Math.round(e.underrated)} points above what its downloads would suggest.
            </p>
          )}
        </dl>
      )}
      {e && e.tied_with.length > 0 && (
        <p className="mt-3 text-xs text-slate-400">
          Statistically tied with:{" "}
          {e.tied_with.slice(0, MAX_TIES).map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <button onClick={() => onSelect(id)} className="text-slate-200 underline-offset-2 hover:underline">
                {evaluation.names[id] ?? id}
              </button>
            </span>
          ))}
          {e.tied_with.length > MAX_TIES && ` and ${e.tied_with.length - MAX_TIES} more`}
        </p>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right tabular-nums text-slate-200">{value}</dd>
    </div>
  );
}
