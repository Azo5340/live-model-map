import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from eval_stats import (  # noqa: E402
    bootstrap_spearman, mcnemar_p, ols_residuals, paired_bootstrap_diff, spearman, wilson,
)


class BasicStatsTest(unittest.TestCase):
    def test_wilson_known_value(self):  # 42/60
        lo, hi = wilson(42, 60)
        self.assertEqual((round(lo, 3), round(hi, 3)), (0.575, 0.801))

    def test_wilson_zero_n(self):
        self.assertEqual(wilson(0, 0), (0.0, 1.0))

    def test_mcnemar_no_discordance(self):
        self.assertEqual(mcnemar_p(0, 0), 1.0)

    def test_mcnemar_known_value(self):
        self.assertEqual(round(mcnemar_p(10, 2), 4), 0.0386)

    def test_mcnemar_is_symmetric(self):
        self.assertEqual(mcnemar_p(2, 10), mcnemar_p(10, 2))

    def test_paired_bootstrap_identical(self):
        a = [True, False] * 30
        self.assertEqual(paired_bootstrap_diff(a, a), (0.0, 0.0, 0.0))

    def test_paired_bootstrap_clear_gap(self):
        a, b = [True] * 55 + [False] * 5, [True] * 35 + [False] * 25
        mean, lo, hi = paired_bootstrap_diff(a, b)
        self.assertAlmostEqual(mean, 20 / 60)
        self.assertTrue(0 < lo < mean < hi)

    def test_spearman_perfect_and_ties(self):
        self.assertEqual(spearman([1, 2, 3], [10, 20, 30]), 1.0)
        self.assertEqual(round(spearman([1, 2, 2, 3], [1, 3, 2, 4]), 3), 0.949)

    def test_bootstrap_spearman_brackets_estimate(self):
        x = list(range(20))
        y = [v + (3 if v % 2 else -3) for v in x]
        rho, lo, hi = bootstrap_spearman(x, y)
        self.assertTrue(lo <= rho <= hi)

    def test_ols_residuals_on_a_line(self):
        self.assertTrue(all(abs(r) < 1e-9 for r in ols_residuals([1, 2, 3], [2, 4, 6])))


if __name__ == "__main__":
    unittest.main()
