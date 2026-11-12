import { statusOf, volumeOf } from "../format";
import type { AIModel, ModelStatus, Providers } from "../types";

export type NodeKind = "engine" | "provider" | "model";
export type LinkKind = "monitor" | "member" | "lineage";

export interface GNode {
  id: string;
  kind: NodeKind;
  name: string;
  provider?: string;
  model?: AIModel;
  avatar?: string | null;
  /** Downloads per day (model), or the sum over its models (provider). */
  volume: number;
  modelCount?: number;
  status: ModelStatus;
  /** Visual hierarchy: 0 = main, 1 = secondary, 2 = minor (by real download rank within its kind). */
  tier: Tier;
  radius: number;
  // Filled in by the force simulation.
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

export interface GLink {
  id: string;
  kind: LinkKind;
  source: string | GNode;
  target: string | GNode;
  /** Real activity of the source, 0 to 1 on a log scale of downloads (monitor links only). */
  activity: number;
}

export const ENGINE_ID = "__engine__";
export const ENGINE_RADIUS = 56;

export type Tier = 0 | 1 | 2;

// Three sizes per kind instead of a continuous scale, so the hierarchy reads at a
// glance; the smallest provider size still keeps logos recognisable.
export const TIER_RADIUS: Record<"provider" | "model", [number, number, number]> = {
  provider: [64, 47, 34],
  model: [22, 15, 10],
};

/** Main = top 15 % by downloads, secondary = next 35 %, minor = the rest. */
function tiers(volumes: Map<string, number>): Map<string, Tier> {
  const ranked = [...volumes.entries()].sort((a, b) => b[1] - a[1]);
  const out = new Map<string, Tier>();
  ranked.forEach(([id, v], i) => {
    const f = ranked.length > 1 ? i / (ranked.length - 1) : 0;
    out.set(id, v <= 0 ? 2 : f < 0.15 ? 0 : f < 0.5 ? 1 : 2);
  });
  return out;
}

// Worst status first: a provider takes the most severe status among its models.
const SEVERITY: ModelStatus[] = ["security_incident", "down", "degraded", "operational", "unknown"];

function worst(statuses: ModelStatus[]): ModelStatus {
  for (const s of SEVERITY) if (statuses.includes(s)) return s;
  return "unknown";
}

/** Activity from real download volume: 0 to 1, log scale. Drives pulse rate and stream width. */
function activityFor(volume: number, maxVolume: number): number {
  if (volume <= 0 || maxVolume <= 0) return 0;
  return Math.log10(1 + volume) / Math.log10(1 + maxVolume);
}

/** Changes only when nodes or links appear/disappear: drives full graph rebuilds. */
export function structureKey(models: Map<string, AIModel>): string {
  return [...models.values()]
    .map((m) => `${m.id}>${m.provider}>${m.parent_model_id ?? ""}`)
    .sort()
    .join("|");
}

/**
 * Builds the engine → provider → model hierarchy plus real lineage links.
 * Existing node objects are reused (and updated in place) so the simulation
 * keeps their positions when the graph is rebuilt.
 */
export function buildGraph(
  models: Map<string, AIModel>,
  providers: Providers,
  cache: Map<string, GNode>,
): { nodes: GNode[]; links: GLink[] } {
  const byProvider = new Map<string, AIModel[]>();
  for (const m of models.values()) {
    byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  }

  const reuse = (id: string, fresh: GNode): GNode => {
    const old = cache.get(id);
    const node = old ? Object.assign(old, fresh, { x: old.x, y: old.y, z: old.z }) : fresh;
    cache.set(id, node);
    return node;
  };

  const engine = reuse(ENGINE_ID, {
    id: ENGINE_ID,
    kind: "engine",
    name: "LIVE ANALYSIS CORE",
    volume: 0,
    status: "operational",
    tier: 0,
    radius: ENGINE_RADIUS,
    fx: 0,
    fy: 0,
    fz: 0,
  });

  const nodes: GNode[] = [engine];
  const links: GLink[] = [];
  const providerVolumes = [...byProvider.values()].map((ms) => ms.reduce((s, m) => s + (volumeOf(m) ?? 0), 0));
  const maxProviderVolume = Math.max(0, ...providerVolumes);
  const maxModelVolume = Math.max(0, ...[...models.values()].map((m) => volumeOf(m) ?? 0));
  const providerTier = tiers(new Map([...byProvider].map(([p, ms]) => [p, ms.reduce((s, m) => s + (volumeOf(m) ?? 0), 0)])));
  const modelTier = tiers(new Map([...models.values()].map((m) => [m.id, volumeOf(m) ?? 0])));

  for (const [provider, ms] of byProvider) {
    const pid = `provider:${provider}`;
    const volume = ms.reduce((s, m) => s + (volumeOf(m) ?? 0), 0);
    nodes.push(
      reuse(pid, {
        id: pid,
        kind: "provider",
        name: provider,
        provider,
        avatar: providers[provider]?.avatar ?? null,
        volume,
        modelCount: ms.length,
        status: worst(ms.map(statusOf)),
        tier: providerTier.get(provider) ?? 2,
        radius: TIER_RADIUS.provider[providerTier.get(provider) ?? 2],
      }),
    );
    links.push({
      id: `${pid}->engine`,
      kind: "monitor",
      source: pid,
      target: ENGINE_ID,
      activity: activityFor(volume, maxProviderVolume),
    });

    for (const m of ms) {
      const volumeM = volumeOf(m) ?? 0;
      nodes.push(
        reuse(m.id, {
          id: m.id,
          kind: "model",
          name: m.name,
          provider,
          model: m,
          volume: volumeM,
          status: statusOf(m),
          tier: modelTier.get(m.id) ?? 2,
          radius: TIER_RADIUS.model[modelTier.get(m.id) ?? 2],
        }),
      );
      links.push({ id: `${pid}->${m.id}`, kind: "member", source: pid, target: m.id, activity: 0 });
      // Every model is checked by the core too: it gets its own stream.
      links.push({
        id: `${m.id}->engine`,
        kind: "monitor",
        source: m.id,
        target: ENGINE_ID,
        activity: activityFor(volumeM, maxModelVolume),
      });
    }
  }

  for (const m of models.values()) {
    if (m.parent_model_id && models.has(m.parent_model_id)) {
      links.push({
        id: `${m.parent_model_id}=>${m.id}`,
        kind: "lineage",
        source: m.parent_model_id,
        target: m.id,
        activity: 0,
      });
    }
  }

  // Forget nodes that left the map.
  const live = new Set(nodes.map((n) => n.id));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);

  return { nodes, links };
}
