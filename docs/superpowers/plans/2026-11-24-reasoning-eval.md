# Reasoning evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the reasoning of the 30 most downloaded open models on paired known / modified maths problems, combine it with LMArena, and show "popularity vs quality" on the 3D map with honest margins of error.

**Architecture:** A daily GitHub Actions job (`evaluate.yml`) runs `pipeline/evaluate.py`: it asks OpenRouter models a fixed set of GSM-Symbolic problems within a hard budget, appends raw answers to `eval/answers.jsonl`, computes statistics (`pipeline/eval_stats.py`) and writes `eval/eval.json`, then commits both. The existing check-up workflow copies `eval/eval.json` into the published data, and the frontend reads it to add a Quality view. Step 0 fixes status flicker and failed deploys first.

**Tech Stack:** Python 3.12 stdlib (+ `certifi`, already used) and `unittest`; React 18 + TypeScript + three.js (existing); GitHub Actions / Pages.

**Spec:** `docs/superpowers/specs/2026-11-24-reasoning-eval-design.md`

## Global Constraints

- Everything in English: code, UI copy, docs, commit messages. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No new frontend dependencies. Python: stdlib + `certifi` only (a maths library only if it makes the code clearer; default is none).
- Spending: hard cap `EVAL_BUDGET_USD`, default `10`. The job must stop *before* a call that could cross it. No recurring cost.
- Models evaluated: the 30 most downloaded map models that OpenRouter serves; already-evaluated models are never re-run.
- 60 problems per set, fixed seed; replies capped at `max_tokens = 4000`; temperature 0; one attempt; a cut-off reply with no answer counts as wrong and is counted as `truncated`.
- The repo stores problem IDs, never problem text.
- Every score shown has a 95 % margin of error; "memorises" and "better than" only when statistically supported; Arena mapping only with ≥ 5 overlapping models.
- Python tests: `python3 -m unittest discover -s tests -v` from the repo root.
- Frontend checks: `cd frontend && npx tsc -b && npx vite build`.

## Review Focus

1. Replies like "The total is $1,250.50." or several numbers and no `Answer:` line → extract the right number (Task 4 tests).
2. OpenRouter errors, 429s, or a response with no `usage.cost` mid-run → stop cleanly, keep every answer already saved, never double-count spend; the next run resumes (Task 5 tests).
3. Before the first evaluation `eval.json` doesn't exist → the site works exactly as today and the Quality button is hidden (Task 8 check).
4. A model with few answers (budget ran out mid-model) → wide intervals, never flagged "memorises", excluded from the headline (Task 6 tests).
5. A manual override or a security incident must still apply immediately despite the new status delay (Task 1 tests).

---

### Task 1: Statuses only change after two passes in a row

**Files:**
- Modify: `pipeline/checkup.py` (status assignment, ~lines 322–352, and change detection ~372–396)
- Create: `tests/test_status.py`, `tests/__init__.py` (empty)

**Interfaces:**
- Produces: `settle_status(previous: dict | None, observed: str, immediate: bool) -> tuple[str, dict | None]` in `pipeline/checkup.py`. `previous` is the model's previous record (`status`, optional `status_pending`); returns `(status_to_publish, new_status_pending)` where `status_pending` is `{"status": str, "seen": int}` or `None`.

- [ ] **Step 1: Write the failing tests** (`tests/test_status.py`, import via `sys.path.insert(0, "pipeline")`)

```python
def test_first_observation_is_published():      # no previous record
    assert settle_status(None, "degraded", False) == ("degraded", None)
def test_change_waits_one_pass():
    assert settle_status({"status": "operational"}, "degraded", False) == ("operational", {"status": "degraded", "seen": 1})
def test_change_applies_on_second_pass():
    prev = {"status": "operational", "status_pending": {"status": "degraded", "seen": 1}}
    assert settle_status(prev, "degraded", False) == ("degraded", None)
def test_flip_back_cancels_pending():
    prev = {"status": "operational", "status_pending": {"status": "degraded", "seen": 1}}
    assert settle_status(prev, "operational", False) == ("operational", None)
def test_immediate_skips_the_wait():            # overrides and security incidents
    assert settle_status({"status": "operational"}, "security_incident", True) == ("security_incident", None)
```

- [ ] **Step 2: Run** `python3 -m unittest tests.test_status -v` → FAIL (`settle_status` not defined).
- [ ] **Step 3: Implement `settle_status`** and call it once per model after the override block: `immediate = bool(override) or m["status"] == "security_incident"`; store the returned pending dict in `m["status_pending"]` (drop the key when `None`). Exclude `status_pending` from the published node only if `public()` already strips internal keys; otherwise keep it (harmless).
- [ ] **Step 4: Run** the tests → PASS. Run `python3 pipeline/checkup.py --out /tmp/lmm-check` twice → exits 0 both times.
- [ ] **Step 5: Commit** `git commit -m "Only change a status after two passes in a row"`

### Task 2: Stop failed deploys

**Files:**
- Modify: `.github/workflows/checkup.yml`

- [ ] **Step 1: Diagnose.** For 3 failed and 3 successful runs, compare the `upload-pages-artifact` and `deploy-pages` logs (`gh run view <id> --log --repo Azo5340/live-model-map`) and the start times of overlapping runs. Write the cause in the commit message.
- [ ] **Step 2: Fix.** If the upload succeeded but `deploy-pages` saw 0 artifacts (listing lag), add a second deploy step `if: steps.deploy.outcome == 'failure'` after `sleep 30` (`continue-on-error: true` on the first). If runs overlap and cancel each other, move `concurrency` to the deploy job with `cancel-in-progress: true` for `schedule`/`workflow_dispatch` runs only.
- [ ] **Step 3: Verify.** Push, then after ≥ 20 runs: `gh run list -L 20 --repo Azo5340/live-model-map --json conclusion --jq 'map(select(.conclusion!="success"))|length'` → `0` or `1`.
- [ ] **Step 4: Commit** with the cause in the body.

User action (not code): add a free Hugging Face read token as repository secret `HF_TOKEN` (Settings → Secrets → Actions).

### Task 3: Basic statistics

**Files:**
- Create: `pipeline/eval_stats.py`, `tests/test_eval_stats.py`

**Interfaces:**
- Produces (all in `eval_stats.py`):
  - `wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]`
  - `mcnemar_p(b: int, c: int) -> float` — exact two-sided binomial p-value on discordant pairs
  - `paired_bootstrap_diff(a: list[bool], b: list[bool], iters: int = 2000, seed: int = 0) -> tuple[float, float, float]` — mean(a) − mean(b), 2.5 % and 97.5 % percentiles
  - `spearman(x: list[float], y: list[float]) -> float` — average ranks for ties
  - `bootstrap_spearman(x, y, iters=2000, seed=0) -> tuple[float, float, float]`
  - `ols_residuals(x: list[float], y: list[float]) -> list[float]`

- [ ] **Step 1: Write the failing tests**

```python
def test_wilson_known_value():        # 42/60
    lo, hi = wilson(42, 60); assert round(lo, 3) == 0.575 and round(hi, 3) == 0.801
def test_wilson_zero_n():             assert wilson(0, 0) == (0.0, 1.0)
def test_mcnemar_no_discordance():    assert mcnemar_p(0, 0) == 1.0
def test_mcnemar_known_value():       assert round(mcnemar_p(10, 2), 4) == 0.0386
def test_paired_bootstrap_identical():
    a = [True, False] * 30; assert paired_bootstrap_diff(a, a) == (0.0, 0.0, 0.0)
def test_spearman_perfect_and_ties():
    assert spearman([1, 2, 3], [10, 20, 30]) == 1.0
    assert round(spearman([1, 2, 2, 3], [1, 3, 2, 4]), 3) == 0.949
def test_ols_residuals_on_a_line():   assert all(abs(r) < 1e-9 for r in ols_residuals([1, 2, 3], [2, 4, 6]))
```

- [ ] **Step 2: Run** `python3 -m unittest tests.test_eval_stats -v` → FAIL (import error).
- [ ] **Step 3: Implement** the six functions with `math` and `random.Random(seed)` only.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the basic statistics for the evaluation"`

### Task 4: Problems and answer reading

**Files:**
- Create: `pipeline/eval_problems.py`, `tests/test_eval_problems.py`

**Interfaces:**
- Produces:
  - `@dataclass Problem: pid: str; known_q: str; known_a: float; modified_q: str; modified_a: float`
  - `load_problems(n: int = 60, seed: int = 7) -> list[Problem]` — reads Hugging Face dataset `apple/GSM-Symbolic`, config `main`, through `https://datasets-server.huggingface.co/rows` (same pattern as `sources/lmarena_source.py`); one row per distinct `original_id`, the row with the lowest `instance`; sample `n` original ids with `random.Random(seed)` sorted by id; `pid = f"{original_id}:{instance}"`. Known = `original_question` / `original_answer`, modified = `question` / `answer`. Answers are the number after `####`.
  - `parse_gold(answer: str) -> float`
  - `extract_answer(reply: str) -> float | None` — last `Answer: <number>` line if present, else the last number in the reply; strips `$`, `,`, `%`, trailing `.`.
  - `PROMPT = "Solve the problem. Think step by step, then write the final answer on the last line as: Answer: <number>\n\nProblem: {question}"`

- [ ] **Step 1: Check the dataset.** `curl -s "https://datasets-server.huggingface.co/rows?dataset=apple/GSM-Symbolic&config=main&split=test&offset=0&length=2"` → rows with `original_id`, `instance`, `question`, `answer`, `original_question`, `original_answer`. If the dataset is gated or the fields differ, stop and report (spec fallback: write our own variants).
- [ ] **Step 2: Write the failing tests**

```python
def test_answer_line_wins():          assert extract_answer("so 3+4=7\nAnswer: 12") == 12.0
def test_money_and_commas():          assert extract_answer("The total is $1,250.50.") == 1250.5
def test_no_number():                 assert extract_answer("I cannot solve this") is None
def test_negative_and_percent():      assert extract_answer("Answer: -15%") == -15.0
def test_parse_gold():                assert parse_gold("He has 5 left.\n#### 1,200") == 1200.0
def test_sample_is_stable(): # uses a fake row list injected through load_problems(rows=...)
    assert [p.pid for p in load_problems(2, 7, rows=FAKE_ROWS)] == [p.pid for p in load_problems(2, 7, rows=FAKE_ROWS)]
```
(`load_problems` takes an optional `rows: list[dict] | None = None` for tests; `FAKE_ROWS` is 5 hand-written rows in the test file.)

- [ ] **Step 3: Run** `python3 -m unittest tests.test_eval_problems -v` → FAIL.
- [ ] **Step 4: Implement.** **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `git commit -m "Load the paired problems and read answers"`

### Task 5: Asking models, within budget

**Files:**
- Create: `pipeline/eval_runner.py`, `tests/test_eval_runner.py`

**Interfaces:**
- Consumes: `Problem`, `PROMPT`, `extract_answer` (Task 4).
- Produces:
  - `class Client(Protocol): def ask(self, openrouter_id: str, prompt: str) -> dict` — returns `{"text": str, "finish_reason": str, "cost": float | None, "prompt_tokens": int, "completion_tokens": int}`; raises `ClientError` on HTTP/network errors.
  - `OpenRouterClient(api_key: str)` — POST `https://openrouter.ai/api/v1/chat/completions` with `temperature: 0`, `max_tokens: 4000`, `usage: {"include": true}`, `provider: {"sort": "price"}` (cheapest route, as the spec asks); `cost` from `usage.cost`.
  - `FakeClient(accuracy_known: float, accuracy_modified: float, seed: int)` — for tests and `--dry-run`, cost `0.001` per call.
  - `run(client, todo: list[tuple[str, str, Problem, str]], answers_path: Path, budget: float, spent: float, price: dict[str, tuple[float, float]]) -> float` — `todo` items are `(model_id, openrouter_id, problem, variant)` with `variant in {"known", "modified"}`; `price[openrouter_id] = (usd_per_prompt_token, usd_per_completion_token)`. Before each call, worst case = `prompt_price * 600 + completion_price * 4000`; stop if `spent + worst > budget`. After each call append one JSON line `{"model_id", "pid", "variant", "reply", "extracted", "gold", "correct", "truncated", "cost", "tokens", "ts"}` and flush. If `cost` is missing, count the worst case. Returns the new `spent`. On `ClientError` for a model, skip that model's remaining items and continue.
  - `load_answers(path: Path) -> list[dict]`, `spent_so_far(answers: list[dict]) -> float`

- [ ] **Step 1: Write the failing tests** (temp directory, `FakeClient`)

```python
def test_stops_before_budget():       # 10 items, worst case 0.03 each, budget 0.1 → at most 3 calls
def test_resume_skips_done():         # run twice on the same file → no duplicate (model_id, pid, variant)
def test_missing_cost_counts_worst_case()
def test_client_error_skips_model_keeps_others()
def test_truncated_reply_is_wrong():  # finish_reason "length", no answer → correct False, truncated True
```
(each with explicit assertions on the number of lines written and the returned `spent`)

- [ ] **Step 2: Run** `python3 -m unittest tests.test_eval_runner -v` → FAIL.
- [ ] **Step 3: Implement.** Resume = the caller filters `todo` against `load_answers`; `run` also skips any item already in the file.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Ask models within a hard budget, saving every answer"`

### Task 6: One quality scale, summary and headline

**Files:**
- Modify: `pipeline/eval_stats.py`
- Create: `pipeline/eval_summary.py`, `tests/test_eval_summary.py`

**Interfaces:**
- Produces in `eval_stats.py`:
  - `bradley_terry(wins: dict[tuple[str, str], int], iters: int = 500) -> dict[str, float]` — MM algorithm (Hunter 2004), returned on an Elo-like scale: `400 * log10(strength)`, centred on mean 0.
  - `fit_linear(x: list[float], y: list[float]) -> tuple[float, float]` — slope, intercept.
- Produces in `eval_summary.py`:
  - `summarize(answers: list[dict], models: list[dict], claimed: dict[str, float | None], now: str) -> dict` writing the `eval.json` shape below.
  - `headline(summary: dict) -> str | None`

`eval.json` shape:
```json
{"generated_at": "...", "budget_usd": 10, "spent_usd": 4.2, "problems": 60,
 "scale": "arena" | "separate",
 "popularity": {"spearman": 0.12, "lo": -0.2, "hi": 0.4, "n": 30} | null,
 "headline": "..." | null,
 "models": {"<hf id>": {
   "known": {"k": 52, "n": 60, "lo": 0.76, "hi": 0.93},
   "modified": {"k": 44, "n": 60, "lo": 0.61, "hi": 0.83},
   "drop": {"mean": 0.13, "lo": 0.03, "hi": 0.23}, "memorises": true,
   "truncated": 1, "claimed_gsm8k": 0.92 | null,
   "quality": {"value": 1180, "lo": 1150, "hi": 1210, "source": "both" | "measured" | "arena"},
   "underrated": 35.0 | null, "tied_with": ["<hf id>"]}}}
```

Rules (pinned by the spec):
- A win for A over B = a problem (both variants count) A got right and B wrong.
- Quality interval: 200 bootstrap resamples of problems, refitting Bradley-Terry each time.
- With ≥ 5 models having both a measured score and an Arena rating, map measured onto Arena with `fit_linear` (`scale: "arena"`); quality of Arena-only models = their Arena rating, `source: "arena"`, interval from Arena if present else `null`. With < 5, `scale: "separate"` and `quality` stays on the measured scale.
- `memorises` only if `drop.lo > 0` and both sets have `n >= 30`.
- `tied_with`: models whose McNemar p ≥ 0.05 against this one (known + modified answers pooled).
- `underrated` = residual of quality on `log10(downloads + 1)`; `null` without quality.
- `popularity` only with ≥ 10 models having quality.
- `headline`, first rule that holds, else `null`:
  1. `"{n} of the {N} most downloaded models reason worse than a model with 10× fewer downloads."` — count models whose quality `hi` < another model's `lo` where that model has ≤ 1/10 of the downloads; only if `n >= 1`.
  2. `"{name} drops {pts} points when only the numbers change."` — the largest `drop.mean` among `memorises` models, `pts = round(100 * mean)`.
  3. `"Downloads barely predict reasoning (ρ = {rho:.2f}, 95 % CI {lo:.2f} to {hi:.2f})."` — if the CI includes 0.

- [ ] **Step 1: Write the failing tests**

```python
def test_bt_orders_by_wins():         # A beats B 8–2, B beats C 8–2 → A > B > C
def test_bt_symmetric_is_tied():      # equal wins → equal scores within 1e-6
def test_memorises_needs_significance(): # 30 known right vs 29 modified right of 60 → False
def test_memorises_clear_drop():      # 55/60 vs 35/60 → True
def test_small_n_never_memorises():   # 10 answers per set → False even with a large drop
def test_separate_scale_under_five_overlap()
def test_headline_none_when_nothing_holds()
def test_headline_rule_1_text():      # exact string for a crafted 3-model case
```

- [ ] **Step 2: Run** `python3 -m unittest tests.test_eval_summary -v` → FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Combine scores into one scale and write the summary"`

### Task 7: The evaluation command and daily job

**Files:**
- Create: `pipeline/evaluate.py`, `.github/workflows/evaluate.yml`, `eval/.gitkeep`
- Modify: `.github/workflows/checkup.yml` (copy step), `README.md` (short "Reasoning evaluation" section)
- Test: `tests/test_evaluate.py`

**Interfaces:**
- Consumes: Tasks 4–6; `fetch_openrouter()` from `sources/openrouter_source.py` (returns `openrouter_id` per HF id, paid listing preferred).
- Produces: CLI `python pipeline/evaluate.py --models-url URL --out eval [--budget 10] [--top 30] [--dry-run]` writing `eval/answers.jsonl` and `eval/eval.json`.

Behaviour:
- Read `models.json` from `--models-url`; candidates = nodes OpenRouter serves, sorted by `usage.download_count_24h`, top `--top`.
- Prices per OpenRouter id from the `/api/v1/models` catalogue (`pricing.prompt`, `pricing.completion`).
- `claimed_gsm8k`: from each candidate's Hugging Face `cardData["model-index"]`, the first result whose dataset name/type contains `gsm8k` (case-insensitive), metric value divided by 100 if > 1.
- `--dry-run` uses `FakeClient(0.9, 0.75, 0)` and `--out` defaults to a temp directory unless given.
- Budget from `--budget`, else env `EVAL_BUDGET_USD`, else 10.

- [ ] **Step 1: Write the failing test** `test_dry_run_end_to_end`: run `main(["--models-url", <file:// URL of a 6-model fixture>, "--out", tmp, "--dry-run", "--top", "3"])` with `load_problems` patched to 4 fake problems → `answers.jsonl` has 3 × 4 × 2 = 24 lines and `eval.json` has 3 models.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_evaluate -v` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Workflow.** `evaluate.yml`: `schedule: cron "17 3 * * *"` and `workflow_dispatch` (input `dry_run`, boolean); `permissions: contents: write`; `concurrency: {group: evaluate, cancel-in-progress: false}`; steps: checkout, setup-python 3.12, `pip install certifi`, run with `OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}` and `EVAL_BUDGET_USD: ${{ vars.EVAL_BUDGET_USD }}` and `--models-url https://azo5340.github.io/live-model-map/data/models.json --out eval`, then commit `eval/` as `github-actions[bot]` only if changed (`git diff --quiet || ...`) and push. Fail early with a clear message if the secret is missing and not `dry_run`.
- [ ] **Step 6: Copy step** in `checkup.yml`, after the check-up: `if [ -f eval/eval.json ]; then cp eval/eval.json frontend/public/data/eval.json; fi`. (Pushes made with the Actions token don't trigger other workflows; the next 15-minute check-up publishes it.)
- [ ] **Step 7: Verify.** `python3 pipeline/evaluate.py --models-url https://azo5340.github.io/live-model-map/data/models.json --dry-run --top 5` → exits 0, prints the summary path; all unit tests pass.
- [ ] **Step 8: Commit** `git commit -m "Add the daily reasoning evaluation job"`

### Task 8: Quality view on the map

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/App.tsx`, `frontend/src/network3d/Network3D.tsx`, `frontend/src/network3d/objects.ts`, `frontend/src/format.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `EvalSummary` and `ModelEval` matching the Task 6 JSON shape.
  - `api.ts`: `Snapshot.evaluation: EvalSummary | null` — `eval.json` fetched alongside the others; a 404 or parse error gives `null` without failing the snapshot.
  - `format.ts`: `qualityColor(value: number, min: number, max: number) -> string` (linear blend `THEME.blue` → `THEME.violet`), `NO_DATA = "#5b6478"`, `BADGE = { underrated: THEME.teal, memorises: "#E5AE4F" }`.
  - `objects.ts`: `setTint(pool: ResourcePool, anim: NodeAnim, color: string)` (same material updates as `setStatus` without touching alerts) and `setBadge(pool, anim, badge: "underrated" | "memorises" | null)` (a thin ring from `pool.ringTexture`).
  - `Network3D` prop `colorMode: "status" | "quality"` and `evaluation: EvalSummary | null`.

Rules: in quality mode, model orbs take `qualityColor` (min/max over models with quality) or `NO_DATA`; providers keep their status colours; badge `memorises` wins over `underrated` if both. Switching back restores status colours. The **Quality** toggle sits next to the existing view controls and is not rendered when `evaluation` is `null`. Changing mode must not rebuild the graph (update materials only).

- [ ] **Step 1: Implement types and API**, run `cd frontend && npx tsc -b` → no errors.
- [ ] **Step 2: Implement colours, badges and the toggle.**
- [ ] **Step 3: Verify without data:** build, serve `dist` with the live data (no `eval.json`) → the map looks as today and no Quality button (screenshot).
- [ ] **Step 4: Verify with data:** copy the dry-run `eval.json` into `dist/data/` → the button appears; quality mode shows blue→violet orbs, grey for untested, rings for badges; toggling back restores status colours; frame rate unchanged (~60 fps with the existing perf script).
- [ ] **Step 5: Commit** `git commit -m "Add a Quality view to the 3D map"`

### Task 9: Quality panel, findings and method page

**Files:**
- Create: `frontend/src/components/QualitySection.tsx`, `frontend/src/components/FindingsCard.tsx`, `frontend/src/components/MethodPanel.tsx`
- Modify: `frontend/src/components/SidePanel.tsx`, `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `EvalSummary`, `ModelEval` (Task 8).
- Produces: `<QualitySection evaluation={...} modelId={...} names={Record<string,string>} onSelect={(id) => void} />`, `<FindingsCard evaluation={...} onOpenMethod={() => void} />`, `<MethodPanel evaluation={...} onClose={() => void} />`.

Content (copy in plain English, as in the spec):
- Quality section (model panel): "Known problems 52/60 (76–93 %)", "Same problems, new numbers 44/60 (61–83 %)", drop with its range and "remembers answers" only when `memorises`; "Authors claim 92 % on GSM8K" when `claimed_gsm8k`; LMArena rating; combined score with range and source; "Tied with: …" as clickable names; "Not tested yet" when the model has no entry.
- Findings card (top of the left column, only when `evaluation` exists): the headline (or "Not enough data yet for a clear finding."), ρ with range, models tested, money spent / budget, last run date, link "How it's measured".
- Method panel: the problems (GSM8K + GSM-Symbolic, 60 each, fixed sample), the exact prompt, how answers are read, the 4,000-token cap, what each statistic means in one sentence, how many models have a claimed score, the budget, and a link to `https://github.com/Azo5340/live-model-map/blob/main/eval/answers.jsonl`.

- [ ] **Step 1: Implement**, `npx tsc -b && npx vite build` → OK.
- [ ] **Step 2: Verify** with the dry-run data: open a tested model, an untested one, the findings card and the method panel (screenshots); Esc / close works; nothing shows without `eval.json`.
- [ ] **Step 3: Commit** `git commit -m "Show quality, findings and method in the panels"`

### Task 10: First real run

User actions first: buy the OpenRouter credit (auto top-up off), create an API key, add it as secret `OPENROUTER_API_KEY`; optionally set variable `EVAL_BUDGET_USD`.

- [ ] **Step 1:** Push all tasks; run `evaluate.yml` by hand with `dry_run: true` → green, commits nothing real (dry-run writes to a temp dir).
- [ ] **Step 2:** Run it for real → green; `eval/answers.jsonl` committed; `spent_usd` ≤ budget.
- [ ] **Step 3:** After the next check-up, the live site shows the Quality button and the findings card.
- [ ] **Step 4: Decide the two conditional items from the spec**, and report to the owner:
  - If most known-set accuracies are above 90 %: add GSM-Symbolic config `p1` as a third set used for ranking only (extend `Problem` with `hard_q`, `hard_a` and the Bradley-Terry wins), as its own small task.
  - If the budget ran out before 30 models: plan item response theory (keep the most informative problems) as its own task.
