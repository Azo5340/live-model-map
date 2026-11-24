import { useEffect } from "react";
import type { EvalSummary } from "../types";

const ANSWERS_URL = "https://github.com/Azo5340/live-model-map/blob/main/eval/answers.jsonl";
const PROMPT =
  "Solve the problem. Think step by step, then write the final answer on the last line as: Answer: <number>";

/** Plain-English explanation of how the reasoning scores are measured. */
export default function MethodPanel({ evaluation, onClose }: { evaluation: EvalSummary; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const claimed = Object.values(evaluation.models).filter((e) => e.claimed_gsm8k != null).length;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <article
        role="dialog"
        aria-label="How it's measured"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-xl border border-white/10 bg-[#0C1328] p-5 text-sm leading-relaxed text-slate-300"
      >
        <header className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-100">How it's measured</h2>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-100">
            ✕
          </button>
        </header>
        <p>
          The question: do the models people download most actually reason better? Each day, the most downloaded
          open models that OpenRouter serves get {evaluation.problems} maths word problems, twice.
        </p>
        <h3 className="mt-4 font-medium text-slate-100">The problems</h3>
        <p>
          A fixed sample from GSM8K, a well-known set of word problems, and the same problems with the names and
          numbers changed (Apple's GSM-Symbolic). A model that does clearly worse on the second version was probably
          remembering answers rather than reasoning.
        </p>
        <h3 className="mt-4 font-medium text-slate-100">How models are asked</h3>
        <p>
          Same instructions for every model, one try per problem, no randomness where the model allows it:
        </p>
        <p className="mt-1 rounded bg-black/30 p-2 font-mono text-xs">{PROMPT}</p>
        <p className="mt-1">
          The answer is read from the last "Answer:" line (or the last number written) and compared with the
          reference. Replies are capped at about 4,000 tokens; one cut off before the end counts as wrong.
        </p>
        <h3 className="mt-4 font-medium text-slate-100">What the numbers mean</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>Every score has a 95 % margin of error: 70 % on 60 problems really means "somewhere around 58–80 %".</li>
          <li>Two models are "tied" when the gap between them could just be luck (McNemar test on the same problems).</li>
          <li>"Remembers answers" only when the drop on the changed problems is clearly more than chance.</li>
          <li>
            The combined score puts these results and LMArena ratings on one scale (Bradley-Terry, the maths LMArena
            uses){evaluation.scale === "separate" ? "; for now too few models have both, or the two rankings don't agree well enough, so the scales are kept apart" : ""}.
          </li>
          <li>"Underrated" means scoring well above what the model's downloads would suggest.</li>
          <li>ρ tells how closely the download ranking matches the quality ranking (1 = same order, 0 = unrelated).</li>
          <li>Authors' own GSM8K claims are shown where the model page has one ({claimed} models).</li>
        </ul>
        <h3 className="mt-4 font-medium text-slate-100">Budget</h3>
        <p>
          A one-time budget of ${evaluation.budget_usd.toFixed(0)}; ${evaluation.spent_usd.toFixed(2)} spent so far.
          Models already tested are never asked again.
        </p>
        <p className="mt-4">
          Every raw answer is public:{" "}
          <a href={ANSWERS_URL} target="_blank" rel="noreferrer" className="text-slate-100 underline underline-offset-2">
            eval/answers.jsonl
          </a>
          .
        </p>
      </article>
    </div>
  );
}
