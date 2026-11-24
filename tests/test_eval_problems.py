import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from eval_problems import extract_answer, load_problems, parse_gold  # noqa: E402

FAKE_ROWS = [
    {"id": str(i), "instance": 0, "question": f"Q{i}?", "answer": f"work\n#### {i * 10}",
     "original_id": str(100 + i), "original_question": f"O{i}?", "original_answer": f"w\n#### {i}"}
    for i in range(5)
]


class AnswerTest(unittest.TestCase):
    def test_answer_line_wins(self):
        self.assertEqual(extract_answer("so 3+4=7\nAnswer: 12"), 12.0)

    def test_money_and_commas(self):
        self.assertEqual(extract_answer("The total is $1,250.50."), 1250.5)

    def test_no_number(self):
        self.assertIsNone(extract_answer("I cannot solve this"))

    def test_negative_and_percent(self):
        self.assertEqual(extract_answer("Answer: -15%"), -15.0)

    def test_bold_answer_line(self):
        self.assertEqual(extract_answer("steps 2 and 3\n**Answer:** 42"), 42.0)

    def test_empty_reply(self):
        self.assertIsNone(extract_answer(""))

    def test_parse_gold(self):
        self.assertEqual(parse_gold("He has 5 left.\n#### 1,200"), 1200.0)


class LoadProblemsTest(unittest.TestCase):
    def test_sample_is_stable(self):
        first = [p.pid for p in load_problems(2, 7, rows=FAKE_ROWS)]
        self.assertEqual(first, [p.pid for p in load_problems(2, 7, rows=FAKE_ROWS)])
        self.assertEqual(len(first), 2)

    def test_pairs_known_and_modified(self):
        p = next(p for p in load_problems(5, 7, rows=FAKE_ROWS) if p.pid == "102:0")
        self.assertEqual((p.known_q, p.known_a, p.modified_q, p.modified_a), ("O2?", 2.0, "Q2?", 20.0))

    def test_numeric_ids_from_the_real_dataset(self):
        rows = [{**r, "original_id": int(r["original_id"])} for r in FAKE_ROWS]
        self.assertEqual(len(load_problems(3, 7, rows=rows)), 3)


if __name__ == "__main__":
    unittest.main()
