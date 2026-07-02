import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.services.reverse.utils import statsig_pure


class StatsigPureTest(unittest.TestCase):
    def test_generate_length_and_structure(self):
        value = statsig_pure.generate(
            "/rest/app-chat/conversations/new", "POST", now_unix=2000000000
        )
        self.assertEqual(len(value), 94)
        ok, msg = statsig_pure.verify_structure(value)
        self.assertTrue(ok, msg)

    def test_two_calls_differ(self):
        a = statsig_pure.generate("/rest/app-chat/conversations/new", "POST")
        b = statsig_pure.generate("/rest/app-chat/conversations/new", "POST")
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main()
