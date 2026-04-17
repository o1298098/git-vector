import sys
import unittest
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from app.audit_helpers import actor_from_user, mask_query_payload


class TestAuditHelpers(unittest.TestCase):
    def test_actor_from_user(self):
        self.assertEqual("anonymous", actor_from_user(None))
        self.assertEqual("admin", actor_from_user(" admin "))

    def test_mask_query_payload(self):
        payload = mask_query_payload("a" * 100, preview_len=10)
        self.assertEqual(100, payload["raw_len"])
        self.assertTrue(payload["masked_preview"].startswith("aaaaaaaaaa"))
        self.assertTrue(payload["masked_preview"].endswith("..."))
        self.assertEqual(64, len(payload["sha256"]))


if __name__ == "__main__":
    unittest.main()
