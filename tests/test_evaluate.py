import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

import evaluate  # noqa: E402
from eval_problems import Problem  # noqa: E402

PROBLEMS = [Problem(f"{i}:0", f"K{i}?", float(i), f"M{i}?", float(i + 50)) for i in range(4)]


def node(i, downloads):
    return {"id": f"org/model-{i}", "name": f"model-{i}", "usage": {"download_count_24h": downloads},
            "metrics": {"elo_score": None}}


class EvaluateTest(unittest.TestCase):
    def test_dry_run_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            graph = {"nodes": [node(i, 1000 * (i + 1)) for i in range(6)]}
            models_file = Path(tmp) / "models.json"
            models_file.write_text(json.dumps(graph))
            # Models 0-4 are on OpenRouter; model 5 (most downloaded) is not.
            catalogue = {f"org/model-{i}": {"openrouter_id": f"org/m{i}", "price": (1e-7, 4e-7)} for i in range(5)}
            out = Path(tmp) / "eval"
            with mock.patch.object(evaluate, "load_problems", return_value=PROBLEMS), \
                    mock.patch.object(evaluate, "fetch_catalogue", return_value=catalogue), \
                    mock.patch.object(evaluate, "fetch_claimed", return_value={}):
                evaluate.main(["--models-url", models_file.as_uri(), "--out", str(out), "--dry-run", "--top", "3"])
            lines = (out / "answers.jsonl").read_text().splitlines()
            summary = json.loads((out / "eval.json").read_text())
        self.assertEqual(len(lines), 3 * 4 * 2)
        self.assertEqual(sorted(summary["models"]), ["org/model-2", "org/model-3", "org/model-4"])

    def test_claimed_gsm8k_from_model_index(self):
        card = {"model-index": [{"results": [
            {"dataset": {"name": "MMLU", "type": "mmlu"}, "metrics": [{"type": "acc", "value": 70}]},
            {"dataset": {"name": "GSM8K (5-shot)", "type": "gsm8k"}, "metrics": [{"type": "acc", "value": 92.5}]},
        ]}]}
        self.assertEqual(evaluate.claimed_gsm8k(card), 0.925)

    def test_claimed_gsm8k_missing(self):
        self.assertIsNone(evaluate.claimed_gsm8k({}))
        self.assertIsNone(evaluate.claimed_gsm8k({"model-index": [{"results": [{"dataset": "bad"}]}]}))

    def test_budget_falls_back_to_env_then_default(self):
        with mock.patch.dict("os.environ", {"EVAL_BUDGET_USD": "4"}):
            self.assertEqual(evaluate.budget_from(None), 4.0)
        with mock.patch.dict("os.environ", {"EVAL_BUDGET_USD": ""}):
            self.assertEqual(evaluate.budget_from(None), 10.0)
        self.assertEqual(evaluate.budget_from(2.5), 2.5)


if __name__ == "__main__":
    unittest.main()
