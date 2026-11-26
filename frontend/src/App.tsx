import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "./api";
import CheckupLog from "./components/CheckupLog";
import EventFeed from "./components/EventFeed";
import FindingsCard from "./components/FindingsCard";
import MethodPanel from "./components/MethodPanel";
import ProviderPanel from "./components/ProviderPanel";
import SidePanel from "./components/SidePanel";
import TodoList from "./components/TodoList";
import { ago, ALERT_STATUSES, BADGE, NO_DATA, QUALITY_RAMP, STATUS, statusOf } from "./format";
import type { Network3DHandle } from "./network3d/Network3D";
import type { AIModel, Checkup, EvalSummary, ModelStatus, Providers, StreamEvent, TodoItem } from "./types";
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
  const [evaluation, setEvaluation] = useState<EvalSummary | null>(null);
  const [colorMode, setColorMode] = useState<"status" | "quality">("status");
  const [methodOpen, setMethodOpen] = useState(false);
  const closeMethod = useCallback(() => setMethodOpen(false), []);
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
      setEvaluation((prev) => (prev?.generated_at === s.evaluation?.generated_at ? prev : s.evaluation));
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
  const selectedProvider = selectedId?.startsWith("provider:") ? selectedId.slice("provider:".length) : null;
  const select = useCallback((id: string) => {
    setSelectedId(id);
    setSidebarOpen(false);
  }, []);
  const clearSelection = useCallback(() => setSelectedId(null), []);

  // Escape returns to the global view (unless it's closing the method dialog).
  const methodOpenRef = useRef(false);
  methodOpenRef.current = methodOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !methodOpenRef.current) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      <header className="flex items-center gap-3 border-b border-white/5 bg-ink px-4 py-2.5">
        <button
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2 py-0.5 text-sm text-slate-300 sm:hidden"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-expanded={sidebarOpen}
          aria-label="Show To review, Feed and Check-ups"
        >
          ☰ <span className="text-xs">To review{todo.length ? ` (${todo.length})` : ""}</span>
        </button>
        <h1 className="text-[19px] font-medium tracking-tight">
          Live Model Map
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
        {sidebarOpen && (
          <button
            aria-label="Close the list"
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 z-20 bg-black/50 sm:hidden"
          />
        )}
        <nav
          className={`${
            sidebarOpen ? "flex" : "hidden"
          } absolute inset-y-0 left-0 z-30 w-72 shrink-0 flex-col border-r border-white/5 bg-panel sm:static sm:flex sm:w-56 lg:w-72`}
        >
          <div className="flex justify-end border-b border-slate-800 px-2 py-1 sm:hidden">
            <button
              onClick={() => setSidebarOpen(false)}
              aria-label="Close the list"
              className="rounded px-2 py-1 text-sm text-slate-300 hover:text-slate-100"
            >
              ✕ Close
            </button>
          </div>
          {evaluation && <FindingsCard evaluation={evaluation} onOpenMethod={() => setMethodOpen(true)} />}
          <div className="flex gap-1 border-b border-slate-800 p-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 whitespace-nowrap rounded-lg px-1.5 py-1 text-xs ${
                  tab === t.id ? "bg-white/[0.08] text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {tab === "todo" && <TodoList items={todo} onSelect={select} />}
            {tab === "events" && <EventFeed events={events} onSelect={select} />}
            {tab === "checkups" && <CheckupLog checkups={checkups} />}
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
                onClear={clearSelection}
                reducedMotion={reducedMotion}
                colorMode={evaluation ? colorMode : "status"}
                evaluation={evaluation}
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
            {evaluation && (
              <div className="pointer-events-auto flex rounded-lg border border-white/5 bg-panel/90 p-0.5 text-xs">
                {(["status", "quality"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setColorMode(mode)}
                    aria-pressed={colorMode === mode}
                    className={`rounded-lg px-2.5 py-1 ${
                      colorMode === mode ? "bg-white/[0.08] text-white" : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {mode === "status" ? "Network" : "Quality"}
                  </button>
                ))}
              </div>
            )}
            {evaluation && colorMode === "quality" ? (
              <div className="pointer-events-auto max-w-[10rem] rounded-lg border border-white/5 bg-panel/90 px-2.5 py-1.5 text-[11px] leading-snug sm:max-w-[13rem] sm:px-3 sm:py-2 sm:text-xs">
                <div
                  className="mb-1 h-2 rounded-full"
                  style={{ background: `linear-gradient(90deg, ${QUALITY_RAMP.join(", ")})` }}
                />
                <div className="flex justify-between gap-3 text-slate-400">
                  <span>Weaker</span>
                  <span>Stronger</span>
                </div>
                <div className="text-slate-400">Reasoning score</div>
                <div className="mt-1.5 flex items-center gap-2 text-slate-300">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: NO_DATA }} /> Not tested
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: BADGE.underrated }} />
                  Underrated
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: BADGE.memorises }} />
                  Drops on new numbers
                </div>
              </div>
            ) : (
            <div className="pointer-events-auto hidden w-[12rem] rounded-xl border border-white/10 bg-panel/90 px-3 py-2.5 text-xs sm:block">
              <p className="text-slate-400">Needs attention</p>
              {ALERT_STATUSES.map((k) => (
                <div key={k} className="flex items-center gap-2 py-0.5">
                  <span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: STATUS[k].color }} />
                  <span className="text-slate-300">{STATUS[k].label}</span>
                  <span className="ml-auto pl-3 tabular-nums text-slate-400">{statusCounts[k]}</span>
                </div>
              ))}
            </div>
            )}
            {webgl && (
              <button
                onClick={() => network.current?.resetCamera()}
                className="pointer-events-auto rounded-lg border border-white/5 bg-panel/90 px-3 py-1.5 text-xs text-slate-300 hover:border-white/15 hover:text-slate-100"
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
                  </main>

        {selected && (
          <div className="absolute inset-0 z-20 md:static md:inset-auto">
            <SidePanel model={selected} evaluation={evaluation} onClose={() => setSelectedId(null)} />
          </div>
        )}
        {selectedProvider && (
          <div className="absolute inset-0 z-20 md:static md:inset-auto">
            <ProviderPanel
              provider={selectedProvider}
              models={models}
              providers={providers}
              onSelect={select}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>
      {methodOpen && evaluation && <MethodPanel evaluation={evaluation} onClose={closeMethod} />}
    </div>
  );
}
