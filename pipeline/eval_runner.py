"""Asks models the problems through OpenRouter, without ever going over budget.

Every answer is appended to a JSONL file as soon as it arrives, so a run that
stops (budget reached, error, timeout) loses nothing, and the next run picks
up where it left off.
"""

import json
import random
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from eval_problems import PROMPT, Problem, extract_answer

try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_TOKENS = 4000
PROMPT_TOKENS_BOUND = 600  # our longest prompt is well under this


class ClientError(Exception):
    pass


class Client(Protocol):
    def ask(self, openrouter_id: str, prompt: str) -> dict: ...


class OpenRouterClient:
    def __init__(self, api_key: str, prices: dict[str, tuple[float, float, float]] | None = None):
        self.api_key = api_key
        self.prices = prices or {}

    def ask(self, openrouter_id: str, prompt: str) -> dict:
        body = {
            "model": openrouter_id,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": MAX_TOKENS,
            "usage": {"include": True},
            "provider": {"sort": "price"},
        }
        if openrouter_id in self.prices:
            # Never fall back to a provider pricier than the catalogue price ($ per million tokens).
            prompt, completion, request = self.prices[openrouter_id]
            body["provider"]["max_price"] = {"prompt": prompt * 1e6, "completion": completion * 1e6, "request": request}
        request = urllib.request.Request(
            CHAT_URL,
            data=json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": "live-model-map/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=300, context=SSL_CONTEXT) as resp:
                data = json.load(resp)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            raise ClientError(str(e)) from e
        if "error" in data or not data.get("choices"):
            raise ClientError(str(data.get("error") or "no reply"))
        choice = data["choices"][0]
        usage = data.get("usage") or {}
        return {
            "text": (choice.get("message") or {}).get("content") or "",
            "finish_reason": choice.get("finish_reason") or "",
            "cost": usage.get("cost"),
            "prompt_tokens": usage.get("prompt_tokens") or 0,
            "completion_tokens": usage.get("completion_tokens") or 0,
        }


class FakeClient:
    """Stand-in for tests and dry runs: right with a set probability, costs 0.001 $ a call."""

    def __init__(self, accuracy_known: float, accuracy_modified: float, seed: int, problems: list[Problem]):
        self.accuracy = {"known": accuracy_known, "modified": accuracy_modified}
        self.rng = random.Random(seed)
        self.gold = {}
        for p in problems:
            self.gold[PROMPT.format(question=p.known_q)] = (p.known_a, "known")
            self.gold[PROMPT.format(question=p.modified_q)] = (p.modified_a, "modified")

    def ask(self, openrouter_id: str, prompt: str) -> dict:
        gold, variant = self.gold[prompt]
        answer = gold if self.rng.random() < self.accuracy[variant] else gold + 1
        return {"text": f"Working...\nAnswer: {answer:g}", "finish_reason": "stop", "cost": 0.001,
                "prompt_tokens": 100, "completion_tokens": 50}


def load_answers(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def spent_so_far(answers: list[dict]) -> float:
    return sum(a.get("cost") or 0 for a in answers)


def run(
    client: Client,
    todo: list[tuple[str, str, Problem, str]],
    answers_path: Path,
    budget: float,
    spent: float,
    price: dict[str, tuple[float, float, float]],
    deadline: float | None = None,
    clock=time.monotonic,
) -> float:
    """Ask each (model, problem, variant) not answered yet; stop before the budget could be crossed.

    price[openrouter_id] = ($ per prompt token, $ per completion token, $ per request).
    Stops at `deadline` (a `clock()` value) so the job always has time to save.
    Scores go to answers_path (public); the reply text, which often restates the
    problem, goes to replies.jsonl next to it (git-ignored, never published). Returns the new total spent.
    """
    done = {(a["model_id"], a["pid"], a["variant"]) for a in load_answers(answers_path)}
    failed_models: set[str] = set()
    worst_seen: dict[str, float] = {}  # a model that costs more than estimated raises its own estimate
    answers_path.parent.mkdir(parents=True, exist_ok=True)
    replies_path = answers_path.with_name("replies.jsonl")
    with answers_path.open("a") as out, replies_path.open("a") as replies:
        for model_id, openrouter_id, problem, variant in todo:
            if (model_id, problem.pid, variant) in done or model_id in failed_models:
                continue
            if deadline is not None and clock() >= deadline:
                break
            prompt_price, completion_price, request_price = price[openrouter_id]
            estimate = prompt_price * PROMPT_TOKENS_BOUND + completion_price * MAX_TOKENS + request_price
            worst = max(estimate, worst_seen.get(openrouter_id, 0.0))
            if spent + worst > budget:
                break
            question, gold = (
                (problem.known_q, problem.known_a) if variant == "known" else (problem.modified_q, problem.modified_a)
            )
            try:
                reply = client.ask(openrouter_id, PROMPT.format(question=question))
            except Exception:  # noqa: BLE001 — any failure only skips this model for this run
                failed_models.add(model_id)
                continue
            cost = reply["cost"] if reply.get("cost") is not None else worst
            worst_seen[openrouter_id] = max(worst_seen.get(openrouter_id, 0.0), cost)
            spent += cost
            extracted = extract_answer(reply["text"])
            truncated = reply["finish_reason"] == "length"
            replies.write(json.dumps({"model_id": model_id, "pid": problem.pid, "variant": variant,
                                      "reply": reply["text"]}) + "\n")
            replies.flush()
            out.write(json.dumps({
                "model_id": model_id,
                "pid": problem.pid,
                "variant": variant,
                "extracted": extracted,
                "gold": gold,
                "correct": extracted is not None and abs(extracted - gold) < 1e-6 and not truncated,
                "truncated": truncated,
                "cost": cost,
                "tokens": {"prompt": reply["prompt_tokens"], "completion": reply["completion_tokens"]},
                "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }) + "\n")
            out.flush()
            done.add((model_id, problem.pid, variant))
    return spent
