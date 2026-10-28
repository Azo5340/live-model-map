import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo, type CSSProperties } from "react";
import { fmt, providerColor, STATUS, statusOf } from "../format";
import type { AIModel } from "../types";
import { NODE_H, NODE_W } from "../layout";

export type ModelNodeData = {
  model: AIModel;
  flash?: "new" | "updated";
  scale: number;
  maxActive: number;
};
export type ModelFlowNode = Node<ModelNodeData, "model">;

function ModelNode({ data, selected }: NodeProps<ModelFlowNode>) {
  const { model, flash, scale, maxActive } = data;
  const status = statusOf(model);
  const { color: statusColor, label: statusLabel } = STATUS[status];

  // Live requests (when a source provides them) drive the pulse: busier = faster and wider.
  const active = model.usage.active_requests_est ?? 0;
  const intensity = maxActive > 0 ? Math.min(active / maxActive, 1) : 0;
  const pulseStyle = {
    "--pulse-duration": `${(3.2 - intensity * 2.4).toFixed(2)}s`,
    "--pulse-scale": (1.05 + intensity * 0.35).toFixed(2),
    borderColor: statusColor,
  } as CSSProperties;

  const flashClass = flash === "new" ? "node-new" : flash === "updated" ? "node-updated" : "";
  const statusClass =
    status === "security_incident" ? "node-incident" : status === "down" ? "node-down" : "";

  return (
    <div
      className={`relative rounded-2xl border-2 bg-slate-900/90 px-[0.85em] py-[0.55em] backdrop-blur ${flashClass} ${statusClass} ${
        selected ? "ring-2 ring-white" : ""
      }`}
      style={{
        width: NODE_W * scale,
        height: NODE_H * scale,
        fontSize: 14 * scale,
        borderColor: statusColor,
        background: `linear-gradient(135deg, ${statusColor}22, rgb(15 23 42 / 0.92) 55%)`,
      }}
      title={model.status_detail ?? statusLabel}
    >
      {active > 0 && <span className="usage-ring" style={pulseStyle} />}
      <Handle type="target" position={Position.Left} className="!bg-slate-500" />
      <div className="flex items-center gap-[0.5em]">
        <span
          className="h-[0.65em] w-[0.65em] shrink-0 rounded-full"
          style={{ background: providerColor(model.provider) }}
        />
        <span className="truncate font-semibold">{model.name}</span>
      </div>
      <div className="flex items-center gap-[0.4em] truncate text-[0.78em] text-slate-400">
        <span className="truncate">{model.provider}</span>
        <span
          className="ml-auto shrink-0 rounded-full px-[0.5em] text-[0.9em] font-medium"
          style={{ color: statusColor, background: `${statusColor}22` }}
        >
          {statusLabel}
        </span>
      </div>
      <div className="mt-[0.4em] grid grid-cols-3 gap-[0.25em] text-[0.78em] text-slate-300">
        <span title="téléchargements / jour (moyenne 30 j)">⬇ {fmt(model.usage.download_count_24h)}</span>
        <span title="contexte">▤ {fmt(model.metrics.context_window)}</span>
        <span title="coût / 1k tokens">$ {fmt(model.metrics.cost_per_1k_tokens, 4)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-slate-500" />
    </div>
  );
}

export default memo(ModelNode);
