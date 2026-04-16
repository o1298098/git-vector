import unittest
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from app.vector_query_fallback import (
    coerce_embedding_to_float_list,
    keyword_boost_for_hit,
    query_tokens_for_boost,
    vector_score_from_embeddings,
)


class TestVectorQueryFallback(unittest.TestCase):
    def test_query_tokens_for_boost_includes_full_query(self) -> None:
        tokens = query_tokens_for_boost("AuthService login_user")
        self.assertIn("authservice login_user", tokens)
        self.assertIn("authservice", tokens)
        self.assertIn("login_user", tokens)
        self.assertLessEqual(len(tokens), 12)

    def test_keyword_boost_has_upper_bound(self) -> None:
        tokens = ["auth", "service", "login", "user", "repo", "path", "call", "tag"]
        boost = keyword_boost_for_hit(
            tokens=tokens,
            content="auth service login user",
            metadata={
                "path": "src/auth/service.py",
                "name": "login_user",
                "tags_csv": "auth,login",
                "calls_csv": "repo,call",
            },
        )
        self.assertGreater(boost, 0.0)
        self.assertLessEqual(boost, 0.35)

    def test_coerce_embedding_from_list(self) -> None:
        emb = coerce_embedding_to_float_list([1, 2.5, "3"])
        self.assertEqual(emb, [1.0, 2.5, 3.0])

    def test_vector_score_from_embeddings_identical(self) -> None:
        score, distance = vector_score_from_embeddings([1.0, 0.0], [1.0, 0.0])
        self.assertIsNotNone(score)
        self.assertIsNotNone(distance)
        assert score is not None and distance is not None
        self.assertAlmostEqual(score, 1.0, places=6)
        self.assertAlmostEqual(distance, 0.0, places=6)

    def test_vector_score_from_embeddings_dim_mismatch(self) -> None:
        score, distance = vector_score_from_embeddings([1.0, 0.0], [1.0, 0.0, 0.5])
        self.assertIsNone(score)
        self.assertIsNone(distance)


if __name__ == "__main__":
    unittest.main()
