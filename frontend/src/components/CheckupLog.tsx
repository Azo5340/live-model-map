import { ago, STATUS } from "../format";
import type { Checkup } from "../types";

export default function CheckupLog({ checkups, onSelect }: { checkups: Checkup[]; onSelect: (id: string) => void }) {
  return (
    <ul className="h-full space-y-1 overflow-y-auto px-2 py-3">
      {checkups.length === 0 && <li className="px-2 text-sm text-slate-500">No check-ups yet.</li>}
      {checkups.map((c) => {
        const ok = c.error_count === 0;
        return (
          <li key={c.ts} className="rounded-lg px-2 py-1.5 text-sm">
            <div className="flex items-center gap-2 text-xs">
              <span className={`h-2 w-2 rounded-full ${ok ? "bg-[#4fb38a]" : "bg-[#d4a948]"}`} />
              <span className="text-slate-300">
                {new Date(c.ts).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}
              </span>
              <span className="text-slate-500">
                {c.initial ? "initial import" : c.full ? "full" : "quick"} · {c.duration_s.toFixed(0)} s
              </span>
              <span className="ml-auto text-[11px] text-slate-500">{ago(c.ts)}</span>
            </div>
            <div className="pl-4 text-xs text-slate-400">
              {c.total} models · {c.checked_status} statuses checked
              {c.added_count > 0 && <span className="text-slate-300"> · {c.added_count} new</span>}
              {c.status_changes.length > 0 && (
                <span className="text-[#9d7fe0]"> · {c.status_changes.length} status changes</span>
              )}
              {c.metric_changes > 0 && <span> · {c.metric_changes} updates</span>}
            </div>
            {c.added.map((a) => (
              <button
                key={a.id}
                onClick={() => onSelect(a.id)}
                className="block max-w-full truncate pl-4 text-left text-xs text-slate-300 hover:underline"
              >
                + {a.name}
              </button>
            ))}
            {c.status_changes.map((s) => (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className="block max-w-full truncate pl-4 text-left text-xs hover:underline"
                style={{ color: STATUS[s.to].color }}
              >
                {s.name} : {s.from ? STATUS[s.from].label : "?"} → {STATUS[s.to].label}
              </button>
            ))}
            {c.errors.map((e, i) => (
              <div key={i} className="truncate pl-4 text-xs text-[#d4a948]" title={e}>
                ⚠ {e}
              </div>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
