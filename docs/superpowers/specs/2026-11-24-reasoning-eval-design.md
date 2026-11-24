# Reasoning evaluation: "popularity ≠ quality" — design

Date: 2026-11-24 · Status: draft, awaiting approval

## Intent

Live Model Map is a portfolio project. It has to stand out, answer a real problem and prove
something concrete. The owner is aiming at **model evaluation** roles, so the map gains a
measured, statistically honest answer to one question:

> **Does what the community downloads match what actually reasons well?**

The proof is a live, numbered headline such as "of the 30 most downloaded open models, N reason
worse than a model with 10× fewer downloads" or "model X loses 15 points when only the numbers in
the problems change". Every number shown comes with its uncertainty.

## Goals

- Measure the **reasoning** of the most downloaded open models ourselves, on two paired sets:
  a known public benchmark and the same problems with names and numbers changed (memorisation test).
- Use **LMArena** ratings whenever a model has one, and put them and our measurements on one scale.
- Compare **claimed** (scores the authors publish on Hugging Face) with **measured**.
- Show it on the existing 3D map and in a short, reproducible methodology section.
- Run automatically in the cloud, like the rest of the project.

## Non-goals

- Evaluating capabilities other than reasoning (code, knowledge, chat, multimodal).
- Ranking closed models; the map is about open models.
- A public leaderboard that anyone can submit models to.
- Replacing LMArena; we complement it where it has no data.

## Anti-goals (a failure even if it works)

- Numbers without uncertainty, or claims the statistics don't support ("A beats B" when they tie).
- Spending beyond the owner's budget, or any recurring charge.
- A map that shows broken or stale data (failed deploys, flapping statuses) next to a page about rigour.
- Results that can't be reproduced from the published raw answers.

## Constraints

- Budget: a one-time OpenRouter credit (~10 $) bought by the owner; no subscription. First full
  evaluation estimated at 4–10 $ (30 models × 60 problems × 2 variants, depending on how long
  models "think"). The pipeline enforces a hard spending cap.
- Only models served on OpenRouter can be measured (151 of the 342 on the map today); the others
  rely on LMArena and claimed scores, with wider uncertainty.
- Free hosting only: GitHub Actions + GitHub Pages, as today.
- The project is entirely in English (code, UI, docs, commit messages).

## Approaches considered

**Where the evaluation runs** (owner picked 1, "to keep it simple"):

1. *Continuous, in GitHub Actions* — a daily job evaluates within the budget and republishes. Live
   and automatic; the most work. **Picked.**
2. *One-off notebook on the owner's Mac* — simpler, but the quality side of the map stops being live.
3. *Both* — cloud job plus a public notebook recomputing the statistics. Rejected for now as extra work.

**Which models can be measured** (owner picked 1):

1. *Small one-time OpenRouter budget* — one key, covers the popular models in hours. **Picked.**
2. *Stack several free tiers* (Groq, GitHub Models, Google AI Studio, Cerebras…) — free but many keys,
   shifting limits and uncertain coverage of popular models.
3. *Only OpenRouter's free models* — 14 exist, 9 on the map, mostly unpopular: too weak a proof.

**Which problems** (owner picked 3):

1. *A public benchmark authors cite* — enables claimed-vs-measured, but may measure memorisation.
2. *Generated problems never seen before* — measures real reasoning, but nothing claimed to compare.
3. *Both, paired: known problems and the same problems with names and numbers changed* — a drop on
   the modified version reveals memorisation. **Picked.**

**Quality metric** — Bradley-Terry fusion of our measurements and LMArena (owner's choice, see below).

## What the owner decided

- Capability: **reasoning**.
- Problems: paired known / modified sets (above).
- Statistics, all of them:
  1. **Confidence intervals** on every accuracy (Wilson interval; bootstrap where a statistic has no
     closed form).
  2. **Paired tests** between models on the same problems (McNemar, or paired bootstrap); the UI says
     "statistically tied" when the difference isn't significant.
  3. **Popularity vs quality**: Spearman rank correlation between downloads and quality, and an
     **"underrated" score** = residual of quality regressed on log(downloads).
  4. **Claimed vs measured**: gap between published and measured scores on the same benchmark, and an
     inflation index per author / model family.
  5. **Bradley-Terry fusion**: our results and LMArena ratings on a single scale, with wider
     uncertainty where only one source exists.
  6. **Item response theory (IRT)** only if the budget gets tight: estimate each problem's difficulty
     and keep the most informative ones (as in "tinyBenchmarks").
- Runs in GitHub Actions, paid once through OpenRouter credits.

## Design

### 0. Fix the audit findings first

A page about rigour can't sit on shaky data. Before the evaluation:
- **Failed deploys**: 66 of the last 200 runs failed at `deploy-pages` ("No artifacts named
  github-pages"), leaving the site up to 2 h stale. Find the cause (likely overlapping runs from the
  10-min schedule, cron-job.org and pushes) and fix it.
- **Hugging Face rate limit**: no `HF_TOKEN` secret is set; the owner adds a free read token.
- **Flapping statuses**: some models changed status 20+ times in two days (217 of the last 300
  events). Add hysteresis: a status only changes after it holds for two consecutive passes.

### 1. Problem sets

- **Known set**: 60 problems sampled with a fixed seed from GSM8K test. *(Builder's call: GSM8K
  because ready-made paired variants exist, see below, and many model cards still report it; MATH-500
  is a fallback if GSM8K proves saturated.)*
- **Modified set**: for each known problem, its counterpart from Apple's **GSM-Symbolic** (same
  problem, names and numbers changed). If its licence doesn't allow redistribution, generate our own
  variants from templates instead and say so in the methodology.
- *Builder's call*: modern models score 90 %+ on GSM8K, which would flatten the ranking. If the
  known-set accuracies cluster above 90 %, add GSM-Symbolic's harder variants (extra clauses, "P1")
  as a third set for ranking, keeping the base pair for the memorisation test.
- *Builder's call*: GSM-Symbolic's licence may forbid redistribution, so the repo stores problem
  ids, not problem text; the job fetches the text at run time.
- Answers are numbers, graded automatically by extracting the final number from the reply.
- One fixed prompt for all models, asking for the final answer on a last line `Answer: <number>`.
  Temperature 0 where supported; one attempt per problem.
- *Builder's call*: replies are capped (`max_tokens` 4000) so "thinking" models can't run up the
  bill; a truncated reply with no answer counts as wrong and is reported as such.

### 2. Which models

- The 30 most downloaded models on the map that OpenRouter serves, re-picked at each run. New
  entrants in the top 30 get evaluated; models already evaluated are not re-run.
- For each model, use the cheapest OpenRouter endpoint for that Hugging Face id.

### 3. The evaluation job

- New workflow `.github/workflows/evaluate.yml`, separate from the check-up, run **daily** and by hand.
- Needs a new secret `OPENROUTER_API_KEY` (created by the owner) and `contents: write`.
- `pipeline/evaluate.py`:
  - loads the raw answers already obtained, picks the missing (model, problem, variant) triples;
  - estimates the cost of each call from OpenRouter pricing and stops before the **spending cap**
    (`EVAL_BUDGET_USD`, default 10) — total spent so far is stored with the results;
  - records every raw answer (prompt id, model, reply, extracted answer, correct, tokens, cost, time);
  - recomputes all statistics and writes `eval.json` for the site.
- Raw answers are committed to the repo under `eval/` (JSONL). This is the persistent store, the
  history and what makes the results reproducible. The check-up workflow copies `eval.json` into the
  site at each deploy.
- Python stdlib by default; *builder's call*: adding `numpy` is acceptable if it keeps the statistics
  code clearer.

### 4. Statistics (`pipeline/eval_stats.py`)

- Per model: accuracy on known and modified sets with 95 % Wilson intervals; **memorisation drop** =
  known − modified, with a paired bootstrap interval; flagged only when the interval excludes 0.
- Pairwise: McNemar tests between models; used to group models that are statistically tied.
- Bradley-Terry: each problem where model A is right and B wrong is a win for A; fit strengths on our
  data, then map them onto the LMArena ELO scale with a linear fit on the models that have both. Models
  with only one source get that source's value and a wider interval. Needs enough overlap; if fewer
  than 5 models have both, show the two scales separately and say why.
- Popularity vs quality: Spearman ρ (with bootstrap interval) between downloads and fused quality;
  "underrated" = residual of quality on log(downloads).
- Claimed vs measured (*builder's call*: shown only where a card reports the same benchmark, which
  may be few models; the methodology says how many): when a model card's `model-index` reports GSM8K, compare it with our known-set
  accuracy; inflation index = mean gap per author.
- The headline sentence is generated from these numbers only when the statistics support it.

### 5. On the map

- A **Quality** toggle on the 3D view. Size keeps meaning popularity; colour becomes fused quality
  (a blue → violet scale from the current palette), grey when unknown.
- Badges on nodes: **underrated** (teal) and **memorises** (warm, only when the drop is significant).
- The model panel gains a Quality section: known / modified accuracy with intervals, claimed vs
  measured, LMArena rating, fused score, and "tied with …" models.
- A **Findings** card with the live headline and the Spearman ρ, and a short **Methodology** section
  (problems, prompt, grading, statistics, budget, link to the raw answers in `eval/`).

### 6. Testing

- Unit tests for answer extraction, Wilson intervals, McNemar, Bradley-Terry and the budget stop,
  against hand-computed values.
- A dry-run mode with a fake model client, so the whole job runs in CI without spending.

## Left to the builder

- Exact prompt wording and answer-extraction rules (documented in the methodology).
- Sample size per set (60 is the starting point; adjust to the budget).
- Bootstrap iteration counts, colour scale details, layout of the new panel sections.
- Whether to trigger IRT (point 6) based on actual spending after the first run.
