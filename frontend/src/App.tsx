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

  // Refresh the "il y a X min" labels.
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
    { id: "todo", label: "À traiter" },
    { id: "events", label: "Fil" },
    { id: "checkups", label: "Check-ups" },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-slate-800/80 bg-[#050816] px-4 py-2.5">
        <button
          className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2 py-0.5 text-sm text-slate-300 sm:hidden"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-expanded={sidebarOpen}
          aria-label="Afficher À traiter, Fil et Check-ups"
        >
          ☰ <span className="text-xs">À traiter{todo.length ? ` (${todo.length})` : ""}</span>
        </button>
        <h1 className="font-semibold tracking-tight">
          Live Model Map <span className="font-normal text-cyan-400/80">· AI observability</span>
        </h1>
        <span className="hidden text-sm text-slate-500 md:inline">
          {models.size} modèles · {Object.keys(providers).length} fournisseurs
        </span>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-xs text-slate-400 sm:flex" title={loadError ?? undefined}>
            <span
              className={`h-2 w-2 rounded-full ${
                fetchState === "error" || stale ? "bg-rose-500" : fetchState === "loading" ? "bg-amber-400" : "bg-emerald-400"
              }`}
            />
            {fetchState === "error"
              ? "Données injoignables"
              : lastCheckup
                ? `Dernier check-up ${ago(lastCheckup.ts)}`
                : "Chargement…"}
          </span>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <nav
          className={`${
            sidebarOpen ? "flex" : "hidden"
          } absolute inset-y-0 left-0 z-30 w-72 shrink-0 flex-col border-r border-slate-800/80 bg-[#060a1c] sm:static sm:flex sm:w-56 lg:w-72`}
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
            <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-sm text-slate-500">Chargement du réseau 3D…</div>}>
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
                Ce navigateur ne prend pas en charge WebGL, nécessaire au réseau 3D. Les listes à gauche restent
                disponibles ; cliquer sur un modèle ouvre ses détails.
              </p>
            </div>
          )}

          <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
            <div className="pointer-events-auto hidden rounded-xl border border-slate-800/80 bg-[#050816]/80 px-3 py-2 text-xs backdrop-blur sm:block">
              {(Object.keys(STATUS) as ModelStatus[]).map((k) => (
                <div key={k} className="flex items-center gap-2 py-0.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS[k].color, boxShadow: `0 0 8px ${STATUS[k].color}` }} />
                  <span className="text-slate-300">{STATUS[k].label}</span>
                  <span className="ml-auto pl-3 font-mono text-slate-500">{statusCounts[k]}</span>
                </div>
              ))}
              <div className="mt-1 max-w-[13rem] border-t border-slate-800 pt-1 leading-snug text-slate-500">
                Volume ∝ téléchargements/jour (rayon ∝ racine cubique). Particules : flux vers le noyau selon ce volume.
              </div>
            </div>
            {webgl && (
              <button
                onClick={() => network.current?.resetCamera()}
                className="pointer-events-auto rounded-lg border border-slate-800 bg-[#050816]/80 px-3 py-1.5 text-xs text-slate-300 backdrop-blur hover:border-cyan-500/40 hover:text-cyan-300"
              >
                Recentrer la vue
              </button>
            )}
          </div>

          {fetchState === "error" && models.size === 0 && (
            <div className="absolute bottom-10 left-3 right-3 z-10 rounded-lg bg-rose-950/95 px-3 py-2 text-sm text-rose-200 sm:right-auto sm:max-w-md">
              Données introuvables : le premier check-up n'a peut-être pas encore tourné. ({loadError})
            </div>
          )}
          {stale && (
            <div className="absolute bottom-10 left-3 right-3 z-10 rounded-lg bg-amber-950/95 px-3 py-2 text-sm text-amber-200 sm:right-auto sm:max-w-md">
              Pas de check-up depuis {ago(lastCheckup.ts).replace("il y a ", "")}. GitHub a peut-être mis le robot en pause
              (onglet Actions du dépôt).
            </div>
          )}
          {webgl && (
            <p className="pointer-events-none absolute bottom-3 left-3 z-10 hidden text-[11px] text-slate-500 sm:block">
              Glisser : pivoter · Molette : zoom · Clic droit : déplacer · Clic sur un modèle : détails
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
