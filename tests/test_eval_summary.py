import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from eval_stats import bradley_terry  # noqa: E402
from eval_summary import headline, summarize  # noqa: E402


def answers_for(model_id, known_right, modified_right, n=60):
    out = []
    for i in range(n):
        out.append({"model_id": model_id, "pid": f"{i}:0", "variant": "known", "correct": i < known_right,
                    "truncated": False, "cost": 0.001})
        out.append({"model_id": model_id, "pid": f"{i}:0", "variant": "modified", "correct": i < modified_right,
                    "truncated": False, "cost": 0.001})
    return out


def node(model_id, downloads, elo=None):
    return {"id": model_id, "name": model_id.upper(), "usage": {"download_count_24h": downloads},
            "metrics": {"elo_score": elo}}


class BradleyTerryTest(unittest.TestCase):
    def test_bt_orders_by_wins(self):
        s = bradley_terry({("a", "b"): 8, ("b", "a"): 2, ("b", "c"): 8, ("c", "b"): 2})
        self.assertTrue(s["a"] > s["b"] > s["c"])

    def test_bt_symmetric_is_tied(self):
        s = bradley_terry({("a", "b"): 5, ("b", "a"): 5})
        self.assertAlmostEqual(s["a"], s["b"], places=6)

    def test_bt_model_with_no_wins_stays_finite(self):
        s = bradley_terry({("a", "b"): 10})
        self.assertTrue(s["a"] > s["b"] > float("-inf"))


class SummaryTest(unittest.TestCase):
    def summary(self, answers, models, claimed=None):
        return summarize(answers, models, claimed or {}, "2026-11-24T00:00:00Z", budget=10)

    def test_memorises_needs_significance(self):
        s = self.summary(answers_for("a", 30, 29), [node("a", 100)])
        self.assertFalse(s["models"]["a"]["memorises"])

    def test_memorises_clear_drop(self):
        s = self.summary(answers_for("a", 55, 35), [node("a", 100)])
        self.assertTrue(s["models"]["a"]["memorises"])
        self.assertAlmostEqual(s["models"]["a"]["drop"]["mean"], 20 / 60)

    def test_small_n_never_memorises(self):
        s = self.summary(answers_for("a", 10, 0, n=10), [node("a", 100)])
        self.assertFalse(s["models"]["a"]["memorises"])

    def test_known_score_has_margin(self):
        k = self.summary(answers_for("a", 42, 40), [node("a", 100)])["models"]["a"]["known"]
        self.assertEqual((k["k"], k["n"], round(k["lo"], 3), round(k["hi"], 3)), (42, 60, 0.575, 0.801))

    def test_separate_scale_under_five_overlap(self):
        answers = answers_for("a", 50, 45) + answers_for("b", 30, 25)
        s = self.summary(answers, [node("a", 100, elo=1300), node("b", 1000, elo=1200), node("c", 5, elo=1100)])
        self.assertEqual(s["scale"], "separate")
        self.assertEqual(s["models"]["a"]["quality"]["source"], "measured")
        self.assertNotIn("c", s["models"])  # Arena-only models need the shared scale

    def test_arena_scale_with_five_overlap(self):
        answers, models = [], []
        for i, m in enumerate("abcde"):
            answers += answers_for(m, 20 + 8 * i, 15 + 8 * i)
            models.append(node(m, 100 * (i + 1), elo=1000 + 50 * i))
        models.append(node("f", 7, elo=1400))
        s = self.summary(answers, models)
        self.assertEqual(s["scale"], "arena")
        self.assertEqual(s["models"]["f"]["quality"]["source"], "arena")
        self.assertEqual(s["models"]["f"]["quality"]["value"], 1400)
        self.assertEqual(s["models"]["c"]["quality"]["source"], "both")

    def test_uncorrelated_overlap_keeps_scales_separate(self):
        # Five models with both scores, but our ranking is the reverse of LMArena's: no shared scale.
        answers, models = [], []
        for i, m in enumerate("abcde"):
            answers += answers_for(m, 20 + 8 * i, 15 + 8 * i)
            models.append(node(m, 100 * (i + 1), elo=1400 - 50 * i))
        s = self.summary(answers, models)
        self.assertEqual(s["scale"], "separate")

    def test_no_pairing_without_shared_problems(self):
        few = [{"model_id": "b", "pid": f"{100 + i}:0", "variant": "known", "correct": True, "truncated": False,
                "cost": 0.001} for i in range(3)]
        s = self.summary(answers_for("a", 40, 40) + answers_for("c", 30, 30) + few,
                         [node("a", 1), node("b", 10**6), node("c", 2)])
        self.assertIsNone(s["models"]["b"]["quality"])
        self.assertNotIn("b", s["models"]["a"]["tied_with"])

    def test_memorises_corrected_for_many_models(self):
        # A 10-point drop (p = 0.002) is clear for one model, but not when 30 models are tested.
        alone = self.summary(answers_for("x", 55, 45), [node("x", 1)])
        self.assertTrue(alone["models"]["x"]["memorises"])
        answers = answers_for("x", 55, 45)
        for i in range(29):
            answers += answers_for(f"m{i}", 40, 40)
        crowd = self.summary(answers, [node("x", 1)] + [node(f"m{i}", 1) for i in range(29)])
        self.assertFalse(crowd["models"]["x"]["memorises"])

    def test_tied_models(self):
        s = self.summary(answers_for("a", 40, 40) + answers_for("b", 41, 40), [node("a", 1), node("b", 2)])
        self.assertEqual(s["models"]["a"]["tied_with"], ["b"])

    def test_claimed_is_reported(self):
        s = self.summary(answers_for("a", 40, 40), [node("a", 1)], claimed={"a": 0.92})
        self.assertEqual(s["models"]["a"]["claimed_gsm8k"], 0.92)

    def test_spent_is_summed(self):
        self.assertAlmostEqual(self.summary(answers_for("a", 1, 1), [node("a", 1)])["spent_usd"], 0.12)


FULL = {"known": {"k": 40, "n": 60, "lo": 0.5, "hi": 0.8}, "modified": {"k": 40, "n": 60, "lo": 0.5, "hi": 0.8},
        "memorises": False, "drop": None}


class HeadlineTest(unittest.TestCase):
    def test_headline_none_when_nothing_holds(self):
        self.assertIsNone(headline({"models": {}, "popularity": None}))

    def test_headline_rule_1_text(self):
        q = lambda v, lo, hi: {"value": v, "lo": lo, "hi": hi, "source": "measured"}  # noqa: E731
        summary = {
            "popularity": None,
            "models": {
                "big": {"downloads": 10000, "quality": q(900, 850, 950), **FULL},
                "mid": {"downloads": 5000, "quality": q(1000, 960, 1040), **FULL},
                "small": {"downloads": 500, "quality": q(1100, 1060, 1140), **FULL},
            },
        }
        self.assertEqual(
            headline(summary),
            "2 of the 3 most downloaded models reason worse than a model with 10× fewer downloads.",
        )

    def test_headline_ignores_models_with_few_answers(self):
        q = lambda v, lo, hi: {"value": v, "lo": lo, "hi": hi, "source": "measured"}  # noqa: E731
        full = {"k": 40, "n": 60, "lo": 0.5, "hi": 0.8}
        few = {"k": 1, "n": 3, "lo": 0.1, "hi": 0.8}
        summary = {"popularity": None, "models": {
            "big": {"downloads": 10000, "quality": q(900, 850, 950), "known": few, "modified": few,
                    "memorises": False, "drop": None},
            "small": {"downloads": 500, "quality": q(1100, 1060, 1140), "known": full, "modified": full,
                      "memorises": False, "drop": None},
        }}
        self.assertIsNone(headline(summary))

    def test_headline_rule_2_text(self):
        summary = {"popularity": None, "names": {"a": "Model A"}, "models": {
            "a": {"downloads": 1, "quality": None, "memorises": True, "drop": {"mean": 0.153}},
        }}
        self.assertEqual(headline(summary), "Model A drops 15 points when only the numbers change.")

    def test_headline_rule_3_text(self):
        summary = {"models": {}, "popularity": {"spearman": 0.12, "lo": -0.2, "hi": 0.41, "n": 30}}
        self.assertEqual(
            headline(summary), "Downloads barely predict reasoning (ρ = 0.12, 95% CI -0.20 to 0.41)."
        )


if __name__ == "__main__":
    unittest.main()
