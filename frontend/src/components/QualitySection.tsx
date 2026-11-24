import { BADGE, fmt, isUnderrated, pct, underratedThreshold } from "../format";
import type { EvalScore, EvalSummary } from "../types";

const MAX_TIES = 6;
const score = (s: EvalScore) => `${s.k}/${s.n} (${pct(s.lo)}–${pct(s.hi)})`;

/** The model panel's reasoning section: measured scores, claimed score, Arena, combined score, ties. */
export default function QualitySection({
  evaluation,
  modelId,
  onSelect,
}: {
  evaluation: EvalSummary;
  modelId: string;
  onSelect: (id: string) => void;
}) {
  const e = evaluation.models[modelId];
  const underrated = isUnderrated(e, underratedThreshold(evaluation.models));
  return (
    <section className="border-t border-slate-800 p-4 text-sm">
      <h3 className="eyebrow mb-2">Reasoning</h3>
      {!e || !e.known ? (
        <p className="text-slate-400">
          Not tested yet.
          {e?.quality ? ` Its score comes from LMArena only (${fmt(Math.round(e.quality.value))}).` : ""}
        </p>
      ) : (
        <dl className="space-y-1.5">
          <Row label="Known problems" value={score(e.known)} />
          {e.modified && <Row label="Same problems, new numbers" value={score(e.modified)} />}
          {e.drop && (
            <Row
              label="Drop on new numbers"
              value={`${Math.round(100 * e.drop.mean)} pts (${Math.round(100 * e.drop.lo)} to ${Math.round(100 * e.drop.hi)})`}
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
          {e.quality && (
            <>
              <Row
                label={evaluation.scale === "arena" ? "Combined score" : "Measured score"}
                value={
                  fmt(Math.round(e.quality.value)) +
                  (e.quality.lo != null && e.quality.hi != null
                    ? ` (${fmt(Math.round(e.quality.lo))}–${fmt(Math.round(e.quality.hi))})`
                    : "")
                }
              />
              <p className="text-[11px] text-slate-400">
                {evaluation.scale === "arena"
                  ? "On the LMArena (Elo) scale: our measurements and LMArena's rating combined."
                  : "On our own scale (0 = average of the models tested); LMArena's Elo is shown above."}
              </p>
            </>
          )}
          {e.claimed_gsm8k != null && (
            <p className="text-[11px] text-slate-400">
              Authors' claims often use several examples or attempts per problem; ours is one try, no examples.
            </p>
          )}
          {underrated && e.underrated != null && (
            <p className="text-xs" style={{ color: BADGE.underrated }}>
              Underrated: {fmt(Math.round(e.underrated))} points above what its downloads would suggest.
            </p>
          )}
        </dl>
      )}
      {e && e.tied_with.length > 0 && (
        <p className="mt-3 text-xs text-slate-400">
          No clear difference from:{" "}
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
      <dd className="text-right font-mono tabular-nums text-slate-200">{value}</dd>
    </div>
  );
}
