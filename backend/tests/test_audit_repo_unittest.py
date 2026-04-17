import sys
import tempfile
import unittest
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from app.audit_repo import AuditRepo


class TestAuditRepo(unittest.TestCase):
    def test_append_and_list_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = AuditRepo(Path(tmp) / "audit.sqlite3")
            ok = repo.append_event(
                event_type="query.search",
                actor="anonymous",
                route="/api/search",
                method="GET",
                resource_type="search",
                resource_id="demo",
                status="ok",
                payload={"masked_preview": "hello", "raw_len": 5},
                ip="127.0.0.1",
                user_agent="unittest",
            )
            self.assertTrue(ok)

            total, rows = repo.list_events(limit=10, offset=0)
            self.assertEqual(1, total)
            self.assertEqual(1, len(rows))
            self.assertEqual("query.search", rows[0]["event_type"])
            self.assertEqual("demo", rows[0]["resource_id"])
            self.assertEqual("hello", rows[0]["payload"]["masked_preview"])
            repo.close()

    def test_list_filters(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = AuditRepo(Path(tmp) / "audit.sqlite3")
            repo.append_event(
                event_type="job.enqueue",
                actor="anonymous",
                route="/api/index-jobs/enqueue",
                method="POST",
                resource_type="index_job",
                resource_id="job-1",
            )
            repo.append_event(
                event_type="project.delete",
                actor="admin",
                route="/api/projects/a",
                method="DELETE",
                resource_type="project",
                resource_id="a",
            )

            total_jobs, rows_jobs = repo.list_events(event_type="job.enqueue", limit=10, offset=0)
            self.assertEqual(1, total_jobs)
            self.assertEqual("job-1", rows_jobs[0]["resource_id"])

            total_admin, rows_admin = repo.list_events(actor="admin", limit=10, offset=0)
            self.assertEqual(1, total_admin)
            self.assertEqual("project.delete", rows_admin[0]["event_type"])
            repo.close()


if __name__ == "__main__":
    unittest.main()
