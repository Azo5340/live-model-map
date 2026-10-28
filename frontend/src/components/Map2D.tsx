import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesState,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import { providerColor, STATUS, statusOf, volumeOf, volumeScale } from "../format";
import { layout } from "../layout";
import type { AIModel } from "../types";
import ModelNode, { type ModelFlowNode } from "./ModelNode";

const nodeTypes = { model: ModelNode };

/** The original flat lineage map (React Flow), kept as the 2D view. */
export default function Map2D({
  models,
  flashes,
  selectedId,
  onSelect,
  onClear,
}: {
  models: Map<string, AIModel>;
  flashes: Record<string, "new" | "updated">;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ModelFlowNode>([]);
  const flow = useRef<ReactFlowInstance<ModelFlowNode> | null>(null);
  const modelCount = useRef(models.size);

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

  // New models arrived: zoom out to show them.
  useEffect(() => {
    if (models.size > modelCount.current && modelCount.current > 0) {
      window.setTimeout(() => flow.current?.fitView({ duration: 800, padding: 0.1 }), 50);
    }
    modelCount.current = models.size;
  }, [models]);

  // Center on the selected model, whichever list it was picked from.
  useEffect(() => {
    if (!selectedId) return;
    const n = flow.current?.getNode(selectedId);
    const s = scales.get(selectedId) ?? 1;
    if (n) flow.current?.setCenter(n.position.x + 110 * s, n.position.y + 48 * s, { zoom: 1.1, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onInit={(instance) => (flow.current = instance)}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={onClear}
      fitView
      minZoom={0.1}
      colorMode="dark"
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
  );
}
