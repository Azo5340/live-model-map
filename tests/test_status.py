import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from checkup import settle_status  # noqa: E402


class SettleStatusTest(unittest.TestCase):
    def test_first_observation_is_published(self):
        self.assertEqual(settle_status(None, "degraded", False), ("degraded", None))

    def test_change_waits_one_pass(self):
        self.assertEqual(
            settle_status({"status": "operational"}, "degraded", False),
            ("operational", {"status": "degraded", "seen": 1}),
        )

    def test_change_applies_on_second_pass(self):
        prev = {"status": "operational", "status_pending": {"status": "degraded", "seen": 1}}
        self.assertEqual(settle_status(prev, "degraded", False), ("degraded", None))

    def test_flip_back_cancels_pending(self):
        prev = {"status": "operational", "status_pending": {"status": "degraded", "seen": 1}}
        self.assertEqual(settle_status(prev, "operational", False), ("operational", None))

    def test_immediate_skips_the_wait(self):
        self.assertEqual(
            settle_status({"status": "operational"}, "security_incident", True),
            ("security_incident", None),
        )

    def test_leaving_an_incident_is_immediate_too(self):
        # A cleared incident or a removed override must not linger for an extra pass.
        self.assertEqual(
            settle_status({"status": "security_incident"}, "operational", False),
            ("operational", None),
        )


if __name__ == "__main__":
    unittest.main()
