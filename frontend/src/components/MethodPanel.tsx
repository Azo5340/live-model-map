import { useEffect, useRef } from "react";
import type { EvalSummary } from "../types";

const ANSWERS_URL = "https://github.com/Azo5340/live-model-map/blob/main/eval/answers.jsonl";
const PROMPT =
  "Solve the problem. Think step by step, then write the final answer on the last line as: Answer: <number>";

/** Plain-English explanation of how the reasoning scores are measured. */
export default function MethodPanel({ evaluation, onClose }: { evaluation: EvalSummary; onClose: () => void }) {
  // A native modal dialog: focus moves inside and stays there, Esc closes it (the "cancel" event),
  // and the browser gives focus back to the button that opened it.
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const claimed = Object.values(evaluation.models).filter((e) => e.claimed_gsm8k != null).length;
  return (
    <dialog
      ref={ref}
      aria-labelledby="method-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-[4px] border border-white/10 bg-panel p-0 text-sm leading-relaxed text-slate-300 backdrop:bg-black/60"
    >
      <article className="p-5">
        <header className="mb-3 flex items-start justify-between gap-3">
          <h2 id="method-title" className="font-serif text-2xl font-medium text-slate-100">How it's measured</h2>
          <button autoFocus onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-100">
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
          numbers changed (Apple's GSM-Symbolic). A model that does clearly worse on the second version may have seen
          the original problems during training (or just finds the new numbers harder).
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
          <li>Every score has a 95% margin of error: 70% on 60 problems really means "somewhere around 58–80%".</li>
          <li>Two models are "tied" when the gap between them could just be luck (McNemar test on the same problems).</li>
          <li>
            "Drops on new numbers" only when the drop is clearly more than chance, with the threshold tightened for the
            number of models tested (Bonferroni correction).
          </li>
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
          A one-time budget of ${evaluation.budget_usd.toFixed(2)}; ${evaluation.spent_usd.toFixed(2)} spent so far.
          Models already tested are never asked again.
        </p>
        <p className="mt-4">
          Every answer's score is public (reply texts aren't published: they often restate the licensed problems):{" "}
          <a href={ANSWERS_URL} target="_blank" rel="noreferrer" className="text-slate-100 underline underline-offset-2">
            eval/answers.jsonl
          </a>
          .
        </p>
      </article>
    </dialog>
  );
}
