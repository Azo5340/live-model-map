import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from eval_problems import Problem  # noqa: E402
from eval_runner import ClientError, FakeClient, load_answers, run, spent_so_far  # noqa: E402

PROBLEMS = [Problem(f"{i}:0", f"K{i}?", float(i), f"M{i}?", float(i + 100)) for i in range(5)]
# worst case per call = 1e-6 * 600 + 7.35e-6 * 4000 + 0 (request fee) = 0.0300
PRICE = {"or/a": (1e-6, 7.35e-6, 0.0), "or/b": (1e-6, 7.35e-6, 0.0)}


def todo(models=("a",), problems=PROBLEMS, variants=("known", "modified")):
    return [(m, f"or/{m}", p, v) for m in models for p in problems for v in variants]


class ScriptedClient:
    """Answers correctly, with a fixed reply shape chosen per test."""

    def __init__(self, cost=0.001, finish="stop", text="Answer: {a}", fail_for=(), error=None):
        self.cost, self.finish, self.text, self.fail_for, self.calls = cost, finish, text, fail_for, 0
        self.error = error or ClientError("HTTP 429")

    def ask(self, openrouter_id, prompt):
        self.calls += 1
        if openrouter_id in self.fail_for:
            raise self.error
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
        self.assertEqual(set(line), {"model_id", "pid", "variant", "extracted", "gold", "correct",
                                     "truncated", "cost", "tokens", "ts"})

    def test_reply_text_kept_out_of_the_public_file(self):
        # Replies often restate the problem, whose licence forbids sharing it.
        run(ScriptedClient(text="Janet has 16 eggs. Answer: 3"), todo(problems=PROBLEMS[:1], variants=("known",)),
            self.path, budget=10, spent=0.0, price=PRICE)
        self.assertNotIn("Janet", self.path.read_text())
        replies = self.path.with_name("replies.jsonl").read_text()
        self.assertIn("Janet", replies)

    def test_unexpected_error_skips_model_keeps_others(self):
        client = ScriptedClient(fail_for=("or/a",), error=ConnectionResetError("reset"))
        run(client, todo(models=("a", "b")), self.path, budget=10, spent=0.0, price=PRICE)
        self.assertEqual({a["model_id"] for a in load_answers(self.path)}, {"b"})

    def test_deadline_stops_the_run(self):
        ticks = iter(range(100))
        client = ScriptedClient()
        run(client, todo(), self.path, budget=10, spent=0.0, price=PRICE, deadline=2.5, clock=lambda: next(ticks))
        self.assertEqual(client.calls, 3)  # clock 0, 1, 2 < 2.5; stops at 3
        self.assertEqual(len(load_answers(self.path)), 3)

    def test_costlier_than_expected_raises_the_estimate(self):
        # Each call really costs 0.05 against an estimate of 0.03: the budget must still hold.
        client = ScriptedClient(cost=0.05)
        spent = run(client, todo(), self.path, budget=0.14, spent=0.0, price=PRICE)
        self.assertLessEqual(spent, 0.14)
        self.assertEqual(client.calls, 2)

    def test_request_fee_counts_in_the_estimate(self):
        price = {"or/a": (1e-6, 7.35e-6, 0.02)}  # worst case 0.05
        client = ScriptedClient(cost=None)
        spent = run(client, todo(), self.path, budget=0.12, spent=0.0, price=price)
        self.assertEqual(client.calls, 2)
        self.assertAlmostEqual(spent, 0.10, places=4)


if __name__ == "__main__":
    unittest.main()
