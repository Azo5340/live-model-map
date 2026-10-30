import { useEffect, useState } from "react";
import { ago, STATUS } from "../format";
import type { TodoItem, TodoKind } from "../types";

const KIND_COLOR: Record<TodoKind, string> = {
  security_incident: STATUS.security_incident.color,
  down: STATUS.down.color,
  degraded: STATUS.degraded.color,
  new_model: "#38bdf8",
};

const STORAGE_KEY = "live-model-map:todo-done";

// "Seen" ticks are a personal convenience, kept in this browser only.
function loadDone(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveDone(done: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...done]));
  } catch {
    /* private mode or storage blocked: ticks just won't persist */
  }
}

export default function TodoList({ items, onSelect }: { items: TodoItem[]; onSelect: (id: string) => void }) {
  const [done, setDone] = useState<Set<string>>(loadDone);
  const [showDone, setShowDone] = useState(false);

  // Forget ticks for items that no longer exist, so storage doesn't grow forever.
  useEffect(() => {
    if (items.length === 0) return;
    const live = new Set(items.map((i) => i.id));
    setDone((d) => {
      const kept = new Set([...d].filter((id) => live.has(id)));
      if (kept.size !== d.size) saveDone(kept);
      return kept.size !== d.size ? kept : d;
    });
  }, [items]);

  const toggle = (id: string) =>
    setDone((d) => {
      const next = new Set(d);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveDone(next);
      return next;
    });

  const open = items.filter((i) => !done.has(i.id));
  const shown = showDone ? items : open;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center px-4 pb-2 pt-3 text-xs">
        <span className="font-semibold text-slate-300">{open.length} to review</span>
        {items.length > open.length && (
          <button className="ml-auto text-slate-500 hover:text-slate-300" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Hide seen" : `Show seen (${items.length - open.length})`}
          </button>
        )}
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {shown.length === 0 && (
          <li className="px-2 text-sm text-slate-500">Nothing to report. Everything is running.</li>
        )}
        {shown.map((item) => {
          const isDone = done.has(item.id);
          return (
            <li
              key={item.id}
              className={`flex gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800 ${isDone ? "opacity-50" : ""}`}
            >
              <input
                type="checkbox"
                checked={isDone}
                onChange={() => toggle(item.id)}
                className="mt-1 shrink-0 accent-sky-500"
                aria-label={`Mark "${item.model_name}" as seen`}
              />
              <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(item.model_id)}>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[item.kind] }} />
                  <span style={{ color: KIND_COLOR[item.kind] }}>{item.title}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-slate-500">{ago(item.since)}</span>
                </div>
                <div className={`truncate ${isDone ? "line-through" : ""}`}>{item.model_name}</div>
                {item.detail && <div className="truncate text-xs text-slate-500">{item.detail}</div>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
