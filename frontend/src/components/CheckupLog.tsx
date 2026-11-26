import { ago } from "../format";
import type { Checkup } from "../types";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line per check-up: when, and what changed. */
export default function CheckupLog({ checkups }: { checkups: Checkup[] }) {
  return (
    <ul className="h-full space-y-0.5 overflow-y-auto px-2 py-3">
      {checkups.length === 0 && <li className="px-2 text-sm text-slate-400">No check-ups yet</li>}
      {checkups.map((c) => {
        const changes = [
          c.added_count > 0 && plural(c.added_count, "new model"),
          c.status_changes.length > 0 && plural(c.status_changes.length, "status change"),
        ].filter(Boolean);
        return (
          <li
            key={c.ts}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm"
            title={c.errors.length ? c.errors.join("\n") : undefined}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.error_count === 0 ? "bg-white/70" : "bg-[#E8B04A]"}`} />
            <span className="min-w-0 flex-1 truncate text-slate-200">{changes.length ? changes.join(" · ") : "No change"}</span>
            <span className="shrink-0 text-xs text-slate-400">{ago(c.ts)}</span>
          </li>
        );
      })}
    </ul>
  );
}
