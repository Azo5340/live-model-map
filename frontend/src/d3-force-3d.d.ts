declare module "d3-force-3d" {
  interface CollideForce<N> {
    (alpha: number): void;
    radius(r: (node: N) => number): CollideForce<N>;
    strength(s: number): CollideForce<N>;
    iterations(i: number): CollideForce<N>;
  }
  export function forceCollide<N>(radius?: (node: N) => number): CollideForce<N>;
}
