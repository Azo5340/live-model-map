"""The problems the models are asked, and how their answers are read.

Each problem comes in two versions from Apple's GSM-Symbolic dataset:
- "known": the original GSM8K word problem, which models may have seen;
- "modified": the same problem with names and numbers changed.

The dataset's licence (CC BY-NC-ND 4.0) doesn't allow sharing the text, so
only problem IDs are stored; the text is downloaded when the job runs.
"""

import json
import random
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass

try:
    import certifi
    import ssl
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = None

FILTER_URL = "https://datasets-server.huggingface.co/filter"

PROMPT = (
    "Solve the problem. Think step by step, then write the final answer on the last line as: "
    "Answer: <number>\n\nProblem: {question}"
)

_NUMBER = r"-?\$?\d[\d,]*(?:\.\d+)?"


@dataclass
class Problem:
    pid: str
    known_q: str
    known_a: float
    modified_q: str
    modified_a: float


def _to_float(text: str) -> float:
    return float(text.replace("$", "").replace(",", "").rstrip("."))


def parse_gold(answer: str) -> float:
    """The reference answer: the number after '####'."""
    return _to_float(answer.split("####")[-1].strip())


def extract_answer(reply: str) -> float | None:
    """The model's final answer: its last 'Answer:' line, else the last number it wrote."""
    lines = re.findall(r"answer\W*?:?\**\s*(" + _NUMBER + ")", reply or "", flags=re.IGNORECASE)
    if lines:
        return _to_float(lines[-1])
    numbers = re.findall(_NUMBER, reply or "")
    return _to_float(numbers[-1]) if numbers else None


def _fetch_rows() -> list[dict]:
    """One version of each of the 100 base problems (instance 0)."""
    rows, offset = [], 0
    while True:
        query = urllib.parse.urlencode({
            "dataset": "apple/GSM-Symbolic", "config": "main", "split": "test",
            "where": '"instance"=0', "offset": offset, "length": 100,
        })
        request = urllib.request.Request(f"{FILTER_URL}?{query}", headers={"User-Agent": "live-model-map/0.1"})
        with urllib.request.urlopen(request, timeout=60, context=SSL_CONTEXT) as resp:
            data = json.load(resp)
        rows += [r["row"] for r in data["rows"]]
        offset += 100
        if offset >= data["num_rows_total"]:
            return rows


def load_problems(n: int = 60, seed: int = 7, rows: list[dict] | None = None) -> list[Problem]:
    """A fixed sample of n paired problems (same seed, same problems, every run)."""
    rows = _fetch_rows() if rows is None else rows
    by_original: dict[str, dict] = {}
    for row in rows:
        oid = str(row["original_id"])
        current = by_original.get(oid)
        if current is None or int(row["instance"]) < int(current["instance"]):
            by_original[oid] = row
    ids = sorted(by_original, key=lambda x: (len(x), x))
    picked = sorted(random.Random(seed).sample(ids, min(n, len(ids))), key=lambda x: (len(x), x))
    return [
        Problem(
            pid=f"{oid}:{by_original[oid]['instance']}",
            known_q=by_original[oid]["original_question"],
            known_a=parse_gold(by_original[oid]["original_answer"]),
            modified_q=by_original[oid]["question"],
            modified_a=parse_gold(by_original[oid]["answer"]),
        )
        for oid in picked
    ]
