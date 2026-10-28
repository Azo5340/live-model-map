import type { Checkup, Graph, StreamEvent, Todo } from "./types";

// The check-up pipeline publishes these files next to the site (data/*.json).
// The query string busts GitHub Pages' cache so each poll sees the latest pass.
async function getJSON<T>(name: string): Promise<T> {
  const url = `${import.meta.env.BASE_URL}data/${name}.json?t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${name}.json`);
  return res.json();
}

export interface Snapshot {
  graph: Graph & { generated_at: string };
  events: StreamEvent[];
  checkups: Checkup[];
  todo: Todo;
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const [graph, events, checkups, todo] = await Promise.all([
    getJSON<Snapshot["graph"]>("models"),
    getJSON<StreamEvent[]>("events"),
    getJSON<Checkup[]>("checkups"),
    getJSON<Todo>("todo"),
  ]);
  return { graph, events, checkups, todo };
}
