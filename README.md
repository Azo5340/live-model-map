# Live Model Map

**Live site: https://azo5340.github.io/live-model-map/**

An interactive 3D map of open AI models: their lineage, price, usage volume, ELO and live status
(operational, degraded, down, security incident). A GitHub Actions check-up runs every ~10
minutes and republishes the site — free, no server.

## How it works

```
GitHub Actions (every ~10 min)
  └─ pipeline/checkup.py
       ├─ reads the previous state back from the published site (data/*.json)
       ├─ Hugging Face : trending models, lineage (base_model), context window, downloads,
       │                 security scan of each repo, provider logos
       ├─ OpenRouter   : price + live availability of every model it serves
       ├─ LMArena      : ELO ratings (public leaderboard dataset)
       ├─ pipeline/status_overrides.json : incidents reported by hand
       └─ writes models.json, events.json, checkups.json, todo.json
  └─ builds the site (frontend/) and publishes it to GitHub Pages

The site re-reads data/*.json every minute and animates what changed.
```

```
live-model-map/
├── .github/workflows/checkup.yml   the workflow (schedule, check-up, publish)
├── pipeline/
│   ├── checkup.py                  one check-up pass
│   └── status_overrides.json       incidents / statuses reported by hand
├── sources/
│   ├── hf_collector.py             Hugging Face source
│   ├── openrouter_source.py        OpenRouter source (price, availability)
│   └── lmarena_source.py           LMArena source (ELO)
└── frontend/                       React site + 3D network (static)
```

## The site

### 3D network

`frontend/src/network3d/` — react-force-graph-3d + Three.js, lazy-loaded:

- **Central "Live Analysis Core"**: the check-up that collects and analyses the data.
- **Providers** around the core: glass spheres with the organization's Hugging Face logo inside
  (initials when it has none). Halo = worst status among its models.
- **Models** orbit their provider, colored by status; violet links = real lineage (`base_model`).
- **Volume**: radius ∝ cube root of downloads/day (so the sphere's volume is proportional to the
  real volume), clamped to a min and max, with animated size changes.
- **Flow**: particles travel from each provider into the core; their count (1 to 4) follows the
  download volume, their color the status. No traffic between models is made up.
- Soft physics (forces, collision avoidance, fixed core), gentle idle float, drag and drop,
  rotate / zoom / pan, hover tooltips, click (details panel + camera fly-to), "Reset view".
- Performance: shared geometries, materials and textures disposed on unmount, a single animation
  loop, capped pixel ratio, rendering paused while the tab is hidden. With the OS "reduce motion"
  setting there is no float, pulse or particles.
- Without WebGL a notice explains it; the lists and the details panel still work.

### Statuses (node color)

| Status | Color | Source |
|---|---|---|
| Operational | green | best OpenRouter provider ≥ 95% available over 30 min |
| Degraded | amber | between 0 and 95% |
| Down | red | 0%, or no provider left |
| Security incident | violet, pulsing | automatic (Hugging Face scan) or reported by hand |
| Unknown | grey | model not served on OpenRouter |

### Sidebar and details panel

- **To review**: security incidents, down and degraded models, and new models (last 3 days).
  "Seen" ticks are remembered in your browser. Items leave the list on their own once the model
  is back to normal.
- **Feed**: every new model and every status or price change.
- **Check-ups**: the history of check-up passes (duration, new models, errors).
- Clicking a model shows its details (only the metrics our sources provide) and compares it with
  its parent or any other model.

### Metrics

| Metric | Source | Coverage |
|---|---|---|
| Cost / 1k tokens | OpenRouter (blended price: 3 input tokens for 1 output token) | models served on OpenRouter |
| Availability 30 min | OpenRouter, best provider | models served on OpenRouter |
| Context window | model `config.json`, else OpenRouter | most models |
| ELO | LMArena text leaderboard, overall | models whose name matches exactly (~70) |
| Downloads / day | Hugging Face (last 30 days ÷ 30) | all models |

ELO ratings are matched by name only when names are identical once case and punctuation are
ignored; variants such as "(Thinking)" aren't attached to the base model, so some models stay
without a rating rather than get a wrong one.

## Automatic security detection

Hugging Face scans the files of every model repo (malware, pickle files that can run code). The
check-up reads that result for every new model and for all models every ~6 h. A file flagged
`unsafe` or `suspicious` turns the model into a **Security incident**, listing the files; the
alert clears by itself once Hugging Face no longer reports anything. The `caution` level (often
a plain Python script) is ignored.

What this doesn't catch: flaws in the model itself (jailbreaks, training-data leaks) or in the
providers serving it. Those are reported by hand.

## Reporting an incident by hand

On GitHub, open `pipeline/status_overrides.json`, click the pencil and add the model:

```json
{
  "models": {
    "org/model": { "status": "security_incident", "detail": "What was found" }
  }
}
```

Commit the change: the workflow runs right away and the map updates within a few minutes. Delete
the entry to clear the alert. An incident reported this way is never cleared by the check-up and
takes precedence over the automatic detection.

## External trigger (reliable 10-minute rhythm)

GitHub's scheduled workflows (`schedule`) are best-effort: they can be delayed by hours, and on
this repo they ran roughly every 4–7 h. A free cron service therefore starts the check-up every
10 minutes through the GitHub API (`workflow_dispatch`). The `schedule` stays as a fallback; two
passes never overlap (`concurrency`).

1. **Scoped GitHub token**: github.com → Settings → Developer settings → Personal access tokens →
   *Fine-grained tokens* → Generate new token.
   - Repository access: *Only select repositories* → `live-model-map`
   - Permissions → Repositories → **Actions: Read and write** (nothing else; Metadata read-only
     is added automatically)
   - Expiration: your choice (renew it before it expires)
2. **cron-job.org** (free account) → Create cronjob:
   - URL: `https://api.github.com/repos/Azo5340/live-model-map/actions/workflows/checkup.yml/dispatches`
   - Schedule: every 10 minutes
   - Advanced → Request method: `POST`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
   - Request body: `{"ref":"main"}`
3. *Test run*: expect **204**. The repo's Actions tab then shows a `workflow_dispatch` run.
   A 403 "Resource not accessible by personal access token" means the token is missing the
   repository or the Actions permission.

The token can only start or cancel this repo's workflows. If it leaks, revoke it on GitHub and
create a new one.

## Known limitations

- **Freshness**: data is about 10 minutes old at most, not real-time to the second.
- **60-day pause**: on a public repo GitHub disables scheduled workflows after 60 days without
  repository activity and sends an email; click "Enable workflow" in the Actions tab. The
  external trigger isn't affected. The site shows a banner when the last check-up is over 40
  minutes old.
- **Hugging Face rate limit**: anonymous requests are rate-limited. The check-up stops asking for
  the rest of the pass and resumes next time. For a larger quota, create a free read token on
  huggingface.co and add it as a repository secret named `HF_TOKEN`
  (Settings → Secrets and variables → Actions).
- **Missing metrics**: none of our sources publish speed, latency, request counts, tokens
  processed, error rates or live user counts. The details panel only shows metrics that exist,
  and node volume is based on downloads (30-day average), not live traffic.
- **Logos** are the avatars each organization chose on Hugging Face and belong to their owners.

## Running locally

Requires Python 3.10+ and Node 22+.

```bash
python3 pipeline/checkup.py                 # writes frontend/public/data/
cd frontend && npm install && npm run dev   # http://localhost:5173
```
