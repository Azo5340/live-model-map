import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from eval_problems import Problem  # noqa: E402
from eval_runner import ClientError, FakeClient, load_answers, run, spent_so_far  # noqa: E402

PROBLEMS = [Problem(f"{i}:0", f"K{i}?", float(i), f"M{i}?", float(i + 100)) for i in range(5)]
# worst case per call = 1e-6 * 600 + 7.35e-6 * 4000 = 0.0300
PRICE = {"or/a": (1e-6, 7.35e-6), "or/b": (1e-6, 7.35e-6)}


def todo(models=("a",), problems=PROBLEMS, variants=("known", "modified")):
    return [(m, f"or/{m}", p, v) for m in models for p in problems for v in variants]


class ScriptedClient:
    """Answers correctly, with a fixed reply shape chosen per test."""

    def __init__(self, cost=0.001, finish="stop", text="Answer: {a}", fail_for=()):
        self.cost, self.finish, self.text, self.fail_for, self.calls = cost, finish, text, fail_for, 0

    def ask(self, openrouter_id, prompt):
        self.calls += 1
        if openrouter_id in self.fail_for:
            raise ClientError("HTTP 429")
        return {"text": self.text, "finish_reason": self.finish, "cost": self.cost,
                "prompt_tokens": 100, "completion_tokens": 200}


class RunTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "answers.jsonl"

    def tearDown(self):
        self.dir.cleanup()

    def test_stops_before_budget(self):
        client = ScriptedClient(cost=0.03)
        spent = run(client, todo(), self.path, budget=0.1, spent=0.0, price=PRICE)
        self.assertEqual(client.calls, 3)
        self.assertEqual(len(load_answers(self.path)), 3)
        self.assertAlmostEqual(spent, 0.09)

    def test_resume_skips_done(self):
        run(FakeClient(1.0, 1.0, 0, PROBLEMS), todo(), self.path, budget=10, spent=0.0, price=PRICE)
        client = ScriptedClient()
        run(client, todo(), self.path, budget=10, spent=0.0, price=PRICE)
        keys = [(a["model_id"], a["pid"], a["variant"]) for a in load_answers(self.path)]
        self.assertEqual(client.calls, 0)
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(len(keys), 10)

    def test_missing_cost_counts_worst_case(self):
        spent = run(ScriptedClient(cost=None), todo(problems=PROBLEMS[:1], variants=("known",)),
                    self.path, budget=10, spent=0.0, price=PRICE)
        self.assertAlmostEqual(spent, 0.0300, places=4)
        self.assertAlmostEqual(spent_so_far(load_answers(self.path)), 0.0300, places=4)

    def test_client_error_skips_model_keeps_others(self):
        client = ScriptedClient(fail_for=("or/a",))
        run(client, todo(models=("a", "b")), self.path, budget=10, spent=0.0, price=PRICE)
        answers = load_answers(self.path)
        self.assertEqual({a["model_id"] for a in answers}, {"b"})
        self.assertEqual(len(answers), 10)
        self.assertEqual(client.calls, 11)  # one failed call for "a", then "a" is skipped

    def test_truncated_reply_is_wrong(self):
        client = ScriptedClient(finish="length", text="Let me think step by step about")
        run(client, todo(problems=PROBLEMS[:1], variants=("known",)), self.path, budget=10, spent=0.0, price=PRICE)
        (answer,) = load_answers(self.path)
        self.assertEqual((answer["correct"], answer["truncated"], answer["extracted"]), (False, True, None))

    def test_fake_client_grades_against_gold(self):
        run(FakeClient(1.0, 0.0, 0, PROBLEMS), todo(), self.path, budget=10, spent=0.0, price=PRICE)
        by_variant = {}
        for a in load_answers(self.path):
            by_variant.setdefault(a["variant"], []).append(a["correct"])
        self.assertEqual((all(by_variant["known"]), any(by_variant["modified"])), (True, False))

    def test_saved_line_has_every_field(self):
        run(ScriptedClient(), todo(problems=PROBLEMS[:1], variants=("known",)), self.path, budget=10, spent=0.0, price=PRICE)
        line = json.loads(self.path.read_text().splitlines()[0])
        self.assertEqual(set(line), {"model_id", "pid", "variant", "reply", "extracted", "gold", "correct",
                                     "truncated", "cost", "tokens", "ts"})


if __name__ == "__main__":
    unittest.main()
