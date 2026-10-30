import { ago, STATUS } from "../format";
import type { TodoItem, TodoKind } from "../types";

const KIND_COLOR: Record<TodoKind, string> = {
  security_incident: STATUS.security_incident.color,
  down: STATUS.down.color,
  degraded: STATUS.degraded.color,
  new_model: "#8ea4c4",
};

/** What needs attention right now; items leave the list once the model is back to normal. */
export default function TodoList({ items, onSelect }: { items: TodoItem[]; onSelect: (id: string) => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-2 pt-3 text-xs font-semibold text-slate-300">{items.length} to review</div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {items.length === 0 && (
          <li className="px-2 text-sm text-slate-500">Nothing to report. Everything is running.</li>
        )}
        {items.map((item) => (
          <li key={item.id}>
            <button
              className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5"
              onClick={() => onSelect(item.model_id)}
            >
              <div className="flex items-center gap-1.5 text-xs">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[item.kind] }} />
                <span style={{ color: KIND_COLOR[item.kind] }}>{item.title}</span>
                <span className="ml-auto shrink-0 text-[11px] text-slate-500">{ago(item.since)}</span>
              </div>
              <div className="truncate">{item.model_name}</div>
              {item.detail && <div className="truncate text-xs text-slate-500">{item.detail}</div>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
