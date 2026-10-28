"""Feed the Live Map with fictional demo models to try the live animations.

    python simulate.py            # seed the lineage, then keep sending updates
    python simulate.py --once     # seed only

All names and numbers are made up; this is not real benchmark data.
"""

import argparse
import random
import time

from push_to_live_map import push_to_live_map

DEMO = [
    # id, name, provider, parent, release, tok/s, latency, cost, ctx, elo
    ("demolab/atlas-1", "Atlas 1", "DemoLab", None, "2025-01-10", 40, 900, 0.0300, 8192, 1100),
    ("demolab/atlas-2", "Atlas 2", "DemoLab", "demolab/atlas-1", "2025-05-02", 55, 700, 0.0200, 32768, 1180),
    ("demolab/atlas-2-mini", "Atlas 2 Mini", "DemoLab", "demolab/atlas-2", "2025-06-20", 140, 250, 0.0020, 32768, 1090),
    ("demolab/atlas-3", "Atlas 3", "DemoLab", "demolab/atlas-2", "2025-11-15", 70, 600, 0.0150, 200000, 1260),
    ("opencorp/nimbus-7b", "Nimbus 7B", "OpenCorp", None, "2025-02-14", 120, 300, 0.0004, 8192, 1020),
    ("opencorp/nimbus-70b", "Nimbus 70B", "OpenCorp", "opencorp/nimbus-7b", "2025-07-01", 45, 800, 0.0030, 65536, 1150),
    ("community/nimbus-70b-coder", "Nimbus 70B Coder", "Community", "opencorp/nimbus-70b", "2025-08-12", 42, 850, 0.0030, 65536, 1170),
]

LATER = [
    ("demolab/atlas-3-mini", "Atlas 3 Mini", "DemoLab", "demolab/atlas-3", "2026-02-01", 180, 200, 0.0015, 128000, 1200),
    ("opencorp/nimbus-2-120b", "Nimbus 2 120B", "OpenCorp", "opencorp/nimbus-70b", "2026-03-10", 50, 700, 0.0040, 131072, 1230),
    ("community/nimbus-2-distill", "Nimbus 2 Distill", "Community", "opencorp/nimbus-2-120b", "2026-04-04", 160, 220, 0.0006, 32768, 1140),
]


def record(row) -> dict:
    mid, name, provider, parent, release, tps, lat, cost, ctx, elo = row
    return {
        "id": mid, "name": name, "provider": provider, "parent_model_id": parent,
        "release_date": release,
        "metrics": {"tokens_per_sec": tps, "latency_ms": lat, "cost_per_1k_tokens": cost,
                    "context_window": ctx, "elo_score": elo},
        "usage_stats": {"download_count_24h": random.randint(500, 50_000),
                        "active_requests_est": random.randint(0, 400)},
    }


def jitter(m: dict) -> dict:
    m = {**m, "metrics": dict(m["metrics"]), "usage_stats": dict(m["usage_stats"])}
    m["metrics"]["tokens_per_sec"] = round(m["metrics"]["tokens_per_sec"] * random.uniform(0.9, 1.1), 1)
    m["metrics"]["latency_ms"] = round(m["metrics"]["latency_ms"] * random.uniform(0.9, 1.1))
    m["usage_stats"]["active_requests_est"] = random.randint(0, 400)
    return m


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=float, default=4.0)
    args = parser.parse_args()

    live = {r[0]: record(r) for r in DEMO}
    print(push_to_live_map(list(live.values()), only_changes=False, source="simulator"))
    pending = list(LATER)

    while not args.once:
        time.sleep(args.interval)
        if pending and random.random() < 0.3:
            m = record(pending.pop(0))
            live[m["id"]] = m
            alerts = [{"message": f"Nouveau modèle détecté : {m['name']}", "level": "info", "model_id": m["id"]}]
            print(push_to_live_map([m], alerts, source="simulator"))
        else:
            m = jitter(random.choice(list(live.values())))
            live[m["id"]] = m
            print(push_to_live_map([m], source="simulator"))
