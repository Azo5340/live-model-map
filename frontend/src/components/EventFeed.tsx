import { STATUS, statusOf } from "../format";
import type { StreamEvent } from "../types";

const STYLE: Record<StreamEvent["type"], { icon: string; cls: string; label: string }> = {
  MODEL_ADDED: { icon: "✦", cls: "text-sky-300", label: "New model" },
  METRICS_UPDATED: { icon: "↻", cls: "text-amber-300", label: "Metrics" },
  STATUS_CHANGED: { icon: "●", cls: "text-violet-300", label: "Status change" },
  ALERT: { icon: "⚠", cls: "text-rose-300", label: "Alert" },
};

function statusText(e: StreamEvent): string | null {
  if (e.type !== "STATUS_CHANGED" || !e.payload.model) return null;
  const now = STATUS[statusOf(e.payload.model)];
  const before = e.payload.previous_status ? STATUS[e.payload.previous_status].label : "?";
  return `${before} → ${now.label}`;
}

export default function EventFeed({
  events,
  onSelect,
}: {
  events: StreamEvent[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {events.length === 0 && (
          <li className="px-2 text-sm text-slate-500">No events yet.</li>
        )}
        {events.map((e, i) => {
          const s = STYLE[e.type];
          const id = e.payload.model?.id ?? e.payload.model_id ?? null;
          const text = e.payload.model?.name ?? e.payload.message ?? "";
          return (
            <li
              key={`${e.ts}-${i}-${id}`}
              className={`feed-in rounded-lg px-2 py-1.5 text-sm ${
                id ? "cursor-pointer hover:bg-slate-800" : ""
              }`}
              onClick={() => id && onSelect(id)}
            >
              <div className="flex items-center gap-2">
                <span className={s.cls}>{s.icon}</span>
                <span className="text-xs text-slate-400">{s.label}</span>
                <span className="ml-auto text-[11px] text-slate-500">
                  {new Date(e.ts).toLocaleTimeString("en-US")}
                </span>
              </div>
              <div className="truncate pl-5">{text}</div>
              {statusText(e) && (
                <div
                  className="truncate pl-5 text-xs"
                  style={{ color: STATUS[statusOf(e.payload.model!)].color }}
                >
                  {statusText(e)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
