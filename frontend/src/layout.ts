import dagre from "@dagrejs/dagre";
import type { Edge, Node, XYPosition } from "@xyflow/react";

export const NODE_W = 220;
export const NODE_H = 96;

const GAP = 60;
const MIN_ROW_WIDTH = 1200;
const ASPECT = 16 / 9;

/** Groups node ids into lineage families (connected components). */
function families(ids: string[], edges: Edge[]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    while (parent.get(id) !== id) id = parent.get(id)!;
    return id;
  };
  for (const e of edges) {
    if (parent.has(e.source) && parent.has(e.target)) parent.set(find(e.source), find(e.target));
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()];
}

/**
 * Each lineage family is laid out left-to-right (parents left, descendants right),
 * then families are packed in rows, biggest first, so isolated models form a grid
 * instead of one endless column.
 */
export function layout<N extends Node>(nodes: N[], edges: Edge[], scaleOf: (id: string) => number): N[] {
  const positions = new Map<string, XYPosition>();
  const blocks = families(nodes.map((n) => n.id), edges).map((ids) => {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 90, marginx: 0, marginy: 0 });
    ids.forEach((id) => g.setNode(id, { width: NODE_W * scaleOf(id), height: NODE_H * scaleOf(id) }));
    const inFamily = new Set(ids);
    edges.forEach((e) => inFamily.has(e.source) && inFamily.has(e.target) && g.setEdge(e.source, e.target));
    dagre.layout(g);
    const local = ids.map((id) => {
      const p = g.node(id);
      return { id, x: p.x - p.width / 2, y: p.y - p.height / 2 };
    });
    const { width = 0, height = 0 } = g.graph();
    return { ids, local, width, height };
  });

  blocks.sort((a, b) => b.ids.length - a.ids.length || b.height - a.height);

  // Aim for a landscape map (~16:9) whatever the number of models.
  const area = blocks.reduce((sum, b) => sum + (b.width + GAP) * (b.height + GAP), 0);
  const rowWidth = Math.max(MIN_ROW_WIDTH, Math.sqrt(area * ASPECT), ...blocks.map((b) => b.width));

  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > rowWidth) {
      x = 0;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    for (const p of block.local) positions.set(p.id, { x: x + p.x, y: y + p.y });
    x += block.width + GAP;
    rowHeight = Math.max(rowHeight, block.height);
  }

  return nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } }));
}
