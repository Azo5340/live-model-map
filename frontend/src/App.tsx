import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "./api";
import CheckupLog from "./components/CheckupLog";
import EventFeed from "./components/EventFeed";
import SidePanel from "./components/SidePanel";
import TodoList from "./components/TodoList";
import { ago, STATUS, statusOf } from "./format";
import type { Network3DHandle } from "./network3d/Network3D";
import type { AIModel, Checkup, ModelStatus, Providers, StreamEvent, TodoItem } from "./types";
import { useLiveData } from "./useLiveData";
import { hasWebGL, useReducedMotion } from "./useReducedMotion";

// three.js is large: load the 3D view on its own so the rest of the page paints first.
const Network3D = lazy(() => import("./network3d/Network3D"));

const FLASH_MS = { new: 4000, updated: 1500 };
type Tab = "todo" | "events" | "checkups";

export default function App() {
  const [models, setModels] = useState<Map<string, AIModel>>(new Map());
  const [providers, setProviders] = useState<Providers>({});
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [checkups, setCheckups] = useState<Checkup[]>([]);
  const [todo, setTodo] = useState<TodoItem[]>([]);
  const [tab, setTab] = useState<Tab>("todo");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [flashes, setFlashes] = useState<Record<string, "new" | "updated">>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const reducedMotion = useReducedMotion();
  const network = useRef<Network3DHandle>(null);
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const webgl = useMemo(hasWebGL, []);

  const flash = useCallback((id: string, kind: "new" | "updated") => {
    setFlashes((f) => ({ ...f, [id]: kind }));
    window.setTimeout(
      () => setFlashes(({ [id]: _, ...rest }) => rest),
      FLASH_MS[kind],
    );
  }, []);

  // Each poll returns the whole map; diff it against what's on screen to animate changes.
  const onSnapshot = useCallback(
    (s: Snapshot) => {
      const before = modelsRef.current;
      if (before.size > 0) {
        for (const m of s.graph.nodes) {
          const old = before.get(m.id);
          if (!old) flash(m.id, "new");
          else if (old.updated_at !== m.updated_at) flash(m.id, "updated");
        }
      }
      setModels(new Map(s.graph.nodes.map((m) => [m.id, m])));
      setProviders((prev) => {
        const next = s.graph.providers ?? {};
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
      setEvents(s.events);
      setCheckups(s.checkups);
      setTodo(s.todo.items);
    },
    [flash],
  );

  const { state: fetchState, error: loadError } = useLiveData(onSnapshot);

  // Refresh the "X min ago" labels.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const selected = selectedId ? models.get(selectedId) : undefined;
  const select = useCallback((id: string) => {
    setSelectedId(id);
    setSidebarOpen(false);
  }, []);

  const statusCounts = useMemo(() => {
    const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0])) as Record<ModelStatus, number>;
    for (const m of models.values()) counts[statusOf(m)]++;
    return counts;
  }, [models]);

  const lastCheckup = checkups[0];
  // Each pass should land every ~10 min; well past that, GitHub probably skipped or paused it.
  const stale = lastCheckup && Date.now() - new Date(lastCheckup.ts).getTime() > 40 * 60_000;
  const tabs: { id: Tab; label: string }[] = [
    { id: "todo", label: "To review" },
    { id: "events", label: "Feed" },
    { id: "checkups", label: "Check-ups" },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/5 bg-[#0b0d12] px-4 py-2.5">
        <button
          className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2 py-0.5 text-sm text-slate-300 sm:hidden"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-expanded={sidebarOpen}
          aria-label="Show To review, Feed and Check-ups"
        >
          ☰ <span className="text-xs">To review{todo.length ? ` (${todo.length})` : ""}</span>
        </button>
        <h1 className="font-semibold tracking-tight">
          Live Model Map <span className="font-normal text-slate-500">· AI observability</span>
        </h1>
        <span className="hidden text-sm text-slate-500 md:inline">
          {models.size} models · {Object.keys(providers).length} providers
        </span>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-xs text-slate-400 sm:flex" title={loadError ?? undefined}>
            <span
              className={`h-2 w-2 rounded-full ${
                fetchState === "error" || stale ? "bg-[#d9645f]" : fetchState === "loading" ? "bg-[#d4a948]" : "bg-[#4fb38a]"
              }`}
            />
            {fetchState === "error"
              ? "Data unreachable"
              : lastCheckup
                ? `Last check-up ${ago(lastCheckup.ts)}`
                : "Loading…"}
          </span>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <nav
          className={`${
            sidebarOpen ? "flex" : "hidden"
          } absolute inset-y-0 left-0 z-30 w-72 shrink-0 flex-col border-r border-white/5 bg-[#0d1015] sm:static sm:flex sm:w-56 lg:w-72`}
        >
          <div className="flex gap-1 border-b border-slate-800 p-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs ${
                  tab === t.id ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {tab === "todo" && <TodoList items={todo} onSelect={select} />}
            {tab === "events" && <EventFeed events={events} onSelect={select} />}
            {tab === "checkups" && <CheckupLog checkups={checkups} onSelect={select} />}
          </div>
        </nav>

        <main className="relative min-w-0 flex-1 overflow-hidden">
          {webgl ? (
            <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-sm text-slate-500">Loading the 3D network…</div>}>
              <Network3D
                ref={network}
                models={models}
                providers={providers}
                selectedId={selectedId}
                flashes={flashes}
                onSelect={select}
                reducedMotion={reducedMotion}
              />
            </Suspense>
          ) : (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-400">
              <p className="max-w-sm">
                This browser doesn't support WebGL, which the 3D network needs. The lists on the left still
                work; clicking a model opens its details.
              </p>
            </div>
          )}

          <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
            <div className="pointer-events-auto hidden rounded-lg border border-white/5 bg-[#0d1015]/90 px-3 py-2 text-xs sm:block">
              {(Object.keys(STATUS) as ModelStatus[]).map((k) => (
                <div key={k} className="flex items-center gap-2 py-0.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS[k].color }} />
                  <span className="text-slate-300">{STATUS[k].label}</span>
                  <span className="ml-auto pl-3 tabular-nums text-slate-500">{statusCounts[k]}</span>
                </div>
              ))}
              <div className="mt-1 max-w-[13rem] border-t border-slate-800 pt-1 leading-snug text-slate-500">
                Volume ∝ downloads/day (radius ∝ cube root). Streams into the core: thickness and speed follow that volume.
              </div>
            </div>
            {webgl && (
              <button
                onClick={() => network.current?.resetCamera()}
                className="pointer-events-auto rounded-lg border border-white/5 bg-[#0d1015]/90 px-3 py-1.5 text-xs text-slate-300 hover:border-white/15 hover:text-slate-100"
              >
                Reset view
              </button>
            )}
          </div>

          {fetchState === "error" && models.size === 0 && (
            <div className="absolute bottom-10 left-3 right-3 z-10 rounded-lg border border-white/5 bg-[#1a1416] px-3 py-2 text-sm text-[#e3b5b2] sm:right-auto sm:max-w-md">
              No data found: the first check-up may not have run yet. ({loadError})
            </div>
          )}
          {stale && (
            <div className="absolute bottom-10 left-3 right-3 z-10 rounded-lg border border-white/5 bg-[#1a1712] px-3 py-2 text-sm text-[#e0c78f] sm:right-auto sm:max-w-md">
              No check-up for {ago(lastCheckup.ts).replace(" ago", "")}. GitHub may have paused the workflow
              (see the repository's Actions tab).
            </div>
          )}
          {webgl && (
            <p className="pointer-events-none absolute bottom-3 left-3 z-10 hidden text-[11px] text-slate-500 sm:block">
              Drag: rotate · Scroll: zoom · Right-drag: pan · Click a model: details
            </p>
          )}
        </main>

        {selected && (
          <div className="absolute inset-0 z-20 md:static md:inset-auto">
            <SidePanel model={selected} models={models} onClose={() => setSelectedId(null)} />
          </div>
        )}
      </div>
    </div>
  );
}
