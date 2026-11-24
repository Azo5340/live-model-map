# Do popular models actually reason better?

Design · 24 November 2026 · Approved

## Why

Live Model Map already shows which open models people download and whether they're up. What it
doesn't show is whether the popular ones are any good. Download counts are easy to read and easy to
mistake for quality.

So I want the map to answer one question, with numbers I can defend:

> **Does what people download match what actually reasons well?**

This is a portfolio project, and I'm aiming at model evaluation work. The point isn't to post another
leaderboard. It's to measure things myself, be honest about how sure I am, and end up with one clear
finding, something like:

- "Of the 30 most downloaded models, N reason worse than a model with 10× fewer downloads."
- "Model X drops 15 points when you only change the numbers in the problems."

## What I want

- Test the reasoning of the most downloaded open models myself.
- Use each problem twice: as published, and with the names and numbers changed. A model that
  drops a lot on the second version was probably remembering answers, not reasoning.
- Use LMArena ratings when a model has one, and put them on the same scale as my results.
- Compare what the authors claim with what I measure.
- Show all of it on the map, with a short page explaining how it was done.
- Keep it running on its own in the cloud, like the rest of the project.

## What I don't want

- Other skills (code, general knowledge, chat). Reasoning only, for now.
- Closed models. The map is about open ones.
- A leaderboard people can submit to.
- Numbers shown without their margin of error, or "A beats B" when the data says they're tied.
- Any monthly cost, or spending more than I set.
- A page about rigour sitting on a map with broken data.
- Results nobody can check.

## Limits I'm working with

- **Money**: one OpenRouter top-up of about $10, paid once. The first full run should cost $4–10
  depending on how long the models "think". The job stops itself before going over the limit.
- **Which models I can test**: only the ones OpenRouter serves (151 of the 342 on the map). The rest
  keep their LMArena rating and claimed scores, with a wider margin of error.
- **Hosting**: free only, GitHub Actions and GitHub Pages, like now.
- **Language**: everything in English.

## Choices made

**Where the tests run.** I considered three options:
1. A daily job on GitHub Actions. **Chosen**, to keep it simple and live.
2. Running it by hand from my Mac. Simpler, but the quality side would stop being live.
3. Both, plus a public notebook. More work than it's worth right now.

**How to pay for the tests.**
1. A one-time OpenRouter top-up. **Chosen**: one key, covers the popular models in a few hours.
2. Combining several free services (Groq, GitHub Models, Google AI Studio…). Free, but lots of keys,
   limits that keep changing, and no guarantee the popular models are there.
3. OpenRouter's free models only. There are 14, nine of them on the map, and hardly anyone downloads
   them. Not enough to prove anything.

**Which problems.**
1. A well-known benchmark. Lets me compare with what authors claim, but models may have seen it.
2. Brand-new generated problems. Nobody has seen them, but there's nothing to compare with.
3. **Both: known problems, and the same problems with names and numbers changed. Chosen.**

**The maths.**
1. **A margin of error on every score.** 70 % on 60 problems really means "somewhere around
   58–80 %", and the map says so.
2. **Is the gap between two models real?** Both answered the same problems, so I can check whether
   the difference is real or just luck. If it's luck, the map says "tied".
3. **Popularity vs quality.** First, does the download ranking match the quality ranking? Then, an
   "underrated" score: how much better a model is than its downloads would suggest.
4. **Claimed vs measured.** The gap between what authors publish and what I get, model by model and
   author by author.
5. **One quality scale.** My results and LMArena's ratings combined into a single score (Bradley-Terry,
   the same maths LMArena uses).
6. **Only if money runs short:** work out which problems tell models apart best and keep only those,
   so I can test with fewer questions (item response theory).

## How it works

### Step 0: fix what's broken

Before adding anything, the map's own data has to be solid:
- **About a third of updates fail to publish.** 66 of the last 200 runs failed on the last step,
  which left the site up to 2 hours behind. Find out why (probably runs overlapping) and fix it.
- **Hugging Face limits our requests** because there's no access key. I'll add a free one.
- **Statuses flicker.** Some models switched status more than 20 times in two days. A status should
  only change once it's been seen twice in a row.

### The problems

- 60 problems picked from GSM8K, a well-known set of maths word problems, always the same 60.
- For each one, its rewritten version from GSM-Symbolic (Apple's study): same problem, different
  names and numbers. If the licence doesn't allow that, I write the variants myself and say so.
- GSM8K is easy for recent models (often 90 %+), so it may not separate them much. If that happens,
  I add GSM-Symbolic's harder version (extra steps in each problem) to rank them, and keep the
  original pair for the "remembering" test.
- The repo only keeps the problem IDs, not the text, in case the licence forbids sharing it. The text
  is downloaded when the job runs.
- Every answer is a number, so grading is automatic. Every model gets the same instructions and has
  to end with `Answer: <number>`. One try per problem, no randomness where the model allows it.
- Answers are capped at about 4,000 tokens so "thinking" models can't run up the bill. An answer cut
  off before the end counts as wrong, and that's shown.

### Which models

- The 30 most downloaded models on the map that OpenRouter serves, re-checked at every run.
- A model that enters the top 30 gets tested. A model already tested isn't tested again.
- Each model goes through the cheapest OpenRouter route available for it.

### The daily job

- A new job, separate from the 15-minute check-up, that runs once a day or on demand.
- It needs an OpenRouter key, which I add as a GitHub secret.
- Each day it:
  - picks up the questions not answered yet;
  - works out what each call will cost and stops before reaching the limit ($10 by default),
    keeping track of the total spent;
  - saves every raw answer: question, model, reply, answer found, right or wrong, cost, time;
  - recomputes all the numbers for the site.
- The raw answers are saved in the repo, in an `eval/` folder. That's the history, and anyone can
  redo the numbers from it.
- Plain Python if possible. A maths library is fine if it makes the code clearer.

### The numbers

- Each model gets a score on the known problems and one on the changed ones, each with a margin of
  error. The drop between the two only shows as "remembers answers" if it's clearly more than chance.
- Models whose difference is just luck are shown as tied.
- On the shared scale, whenever one model gets a problem right that another gets wrong, that counts
  as a win. That puts my results on the same scale as LMArena's, using the models that have both. If
  fewer than 5 models have both, I show the two scales side by side and explain why.
- Popularity vs quality: how closely the two rankings match, with a margin of error, plus the
  "underrated" score.
- Claimed vs measured only shows when a model page reports a GSM8K score. That may be only a few
  models, and the explanation page will say how many.
- The headline sentence is written from the numbers, and only if the numbers back it up.

### On the map

- A **Quality** button on the 3D view. Size still means downloads. Colour shows quality, from blue to
  violet, and grey when there's no data.
- Two badges: **underrated** and **remembers answers** (only when it's clear).
- The model panel gets a quality section: both scores with their margins, claimed vs measured, the
  LMArena rating, the combined score, and which models it's tied with.
- A **Findings** card with the headline, and a short **How it's measured** page with a link to the
  raw answers.

### Tests

- Check by hand-computed examples: finding the answer in a reply, margins of error, the "real or
  luck" test, the shared scale, and the job stopping at the spending limit.
- A practice mode with a fake model, so the whole job can be tested without spending anything.

## Still open

- Exact wording of the instructions and how to read the answer, written up on the explanation page.
- How many problems per set (60 to start, adjusted to the budget).
- Colours and the layout of the new panel.
- Whether to use step 6 of the maths, depending on what the first run costs.
