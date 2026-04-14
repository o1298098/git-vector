from fastapi.testclient import TestClient

from app.main import app


def test_health_ok():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json().get("status") == "ok"
    assert response.headers.get("x-request-id")


def test_404_uses_error_contract():
    client = TestClient(app)
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    body = response.json()
    assert body.get("code")
    assert "message" in body
    assert "retryable" in body
    assert "request_id" in body
