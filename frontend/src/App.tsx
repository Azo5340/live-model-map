import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesState,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "./api";
import CheckupLog from "./components/CheckupLog";
import EventFeed from "./components/EventFeed";
import ModelNode, { type ModelFlowNode } from "./components/ModelNode";
import SidePanel from "./components/SidePanel";
import TodoList from "./components/TodoList";
import { ago, providerColor, STATUS, statusOf, volumeOf, volumeScale } from "./format";
import { layout } from "./layout";
import type { AIModel, Checkup, ModelStatus, StreamEvent, TodoItem } from "./types";
import { useLiveData } from "./useLiveData";

const nodeTypes = { model: ModelNode };
const FLASH_MS = { new: 4000, updated: 1500 };
type Tab = "todo" | "events" | "checkups";

export default function App() {
  const [models, setModels] = useState<Map<string, AIModel>>(new Map());
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [checkups, setCheckups] = useState<Checkup[]>([]);
  const [todo, setTodo] = useState<TodoItem[]>([]);
  const [tab, setTab] = useState<Tab>("todo");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [flashes, setFlashes] = useState<Record<string, "new" | "updated">>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<ModelFlowNode>([]);
  const [, setTick] = useState(0);
  const flow = useRef<ReactFlowInstance<ModelFlowNode> | null>(null);
  const modelsRef = useRef(models);
  modelsRef.current = models;

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
      const firstLoad = before.size === 0;
      let added = false;
      for (const m of s.graph.nodes) {
        const old = before.get(m.id);
        if (firstLoad) continue;
        if (!old) {
          flash(m.id, "new");
          added = true;
        } else if (old.updated_at !== m.updated_at) {
          flash(m.id, "updated");
        }
      }
      setModels(new Map(s.graph.nodes.map((m) => [m.id, m])));
      setEvents(s.events);
      setCheckups(s.checkups);
      setTodo(s.todo.items);
      if (added) window.setTimeout(() => flow.current?.fitView({ duration: 800, padding: 0.1 }), 50);
    },
    [flash],
  );

  const { state: fetchState, error: loadError } = useLiveData(onSnapshot);

  // Refresh the "il y a X min" labels.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const edges: Edge[] = useMemo(
    () =>
      [...models.values()]
        .filter((m) => m.parent_model_id && models.has(m.parent_model_id))
        .map((m) => ({
          id: `${m.parent_model_id}->${m.id}`,
          source: m.parent_model_id!,
          target: m.id,
          animated: true,
          style: { stroke: providerColor(m.provider), strokeWidth: 1.5, opacity: 0.7 },
        })),
    [models],
  );

  // Bigger node = more usage volume. Rounded so tiny changes don't trigger a re-layout.
  const scales = useMemo(() => {
    const maxVolume = Math.max(0, ...[...models.values()].map((m) => volumeOf(m) ?? 0));
    return new Map(
      [...models.values()].map((m) => [m.id, Math.round(volumeScale(volumeOf(m), maxVolume) * 20) / 20]),
    );
  }, [models]);

  // Only re-run the (expensive) layout when the graph structure or node sizes
  // change, so metric updates don't move nodes the user may have dragged.
  const structureKey = useMemo(
    () =>
      [...models.keys()].sort().map((id) => `${id}:${scales.get(id)}`).join("|") +
      "#" + edges.map((e) => e.id).sort().join("|"),
    [models, edges, scales],
  );
  const positions = useMemo(() => {
    const laid = layout(
      [...models.keys()].map((id) => ({ id, position: { x: 0, y: 0 }, data: {} })),
      edges,
      (id) => scales.get(id) ?? 1,
    );
    return new Map(laid.map((n) => [n.id, n.position]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  const maxActive = useMemo(
    () => Math.max(0, ...[...models.values()].map((m) => m.usage.active_requests_est ?? 0)),
    [models],
  );

  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return [...models.values()].map((m) => {
        const old = prevById.get(m.id);
        return {
          id: m.id,
          type: "model" as const,
          position: old?.position ?? positions.get(m.id) ?? { x: 0, y: 0 },
          selected: m.id === selectedId,
          data: { model: m, flash: flashes[m.id], scale: scales.get(m.id) ?? 1, maxActive },
        };
      });
    });
  }, [models, positions, flashes, scales, maxActive, selectedId, setNodes]);

  // A structural change means new layout positions: apply them.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })));
  }, [positions, setNodes]);

  const selected = selectedId ? models.get(selectedId) : undefined;
  const select = (id: string) => {
    setSelectedId(id);
    setSidebarOpen(false);
    const n = flow.current?.getNode(id);
    const s = scales.get(id) ?? 1;
    if (n) flow.current?.setCenter(n.position.x + 110 * s, n.position.y + 48 * s, { zoom: 1.1, duration: 600 });
  };

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
      <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-2.5">
        <button
          className="rounded-md border border-slate-700 px-2 py-0.5 text-sm text-slate-300 lg:hidden"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="Afficher la liste à traiter"
        >
          ☰
        </button>
        <h1 className="font-semibold tracking-tight">Live Model Map</h1>
        <span className="hidden text-sm text-slate-500 sm:inline">{models.size} modèles</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400" title={loadError ?? undefined}>
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
      </header>

      <div className="relative flex min-h-0 flex-1">
        <nav
          className={`${
            sidebarOpen ? "flex" : "hidden"
          } absolute inset-y-0 left-0 z-30 w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-950 lg:static lg:flex`}
        >
          <div className="flex gap-1 border-b border-slate-800 p-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 rounded-md px-2 py-1 text-xs ${
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

        <main className="relative min-w-0 flex-1">
          <div className="absolute right-3 top-3 z-10 rounded-xl border border-slate-800 bg-slate-950/85 px-3 py-2 text-xs backdrop-blur">
            {(Object.keys(STATUS) as ModelStatus[]).map((k) => (
              <div key={k} className="flex items-center gap-2 py-0.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS[k].color }} />
                <span className="text-slate-300">{STATUS[k].label}</span>
                <span className="ml-auto pl-3 font-mono text-slate-500">{statusCounts[k]}</span>
              </div>
            ))}
            <div className="mt-1 border-t border-slate-800 pt-1 text-slate-500">Taille du nœud = volume d'usage</div>
          </div>
          {fetchState === "error" && models.size === 0 && (
            <div className="absolute left-4 top-4 z-10 max-w-md rounded-lg bg-rose-950 px-3 py-2 text-sm text-rose-200">
              Données introuvables : le premier check-up n'a peut-être pas encore tourné. ({loadError})
            </div>
          )}
          {stale && (
            <div className="absolute left-4 top-4 z-10 max-w-md rounded-lg bg-amber-950 px-3 py-2 text-sm text-amber-200">
              Pas de check-up depuis {ago(lastCheckup.ts).replace("il y a ", "")}. GitHub a peut-être mis le robot en pause
              (onglet Actions du dépôt).
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onInit={(instance) => (flow.current = instance)}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            minZoom={0.1}
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} color="#1e293b" />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => STATUS[statusOf((n.data as { model: AIModel }).model)].color}
              maskColor="rgba(2,6,23,0.7)"
              style={{ background: "#0f172a" }}
            />
            <Controls />
          </ReactFlow>
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
