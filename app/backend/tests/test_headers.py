"""セキュリティヘッダ・本番での /docs 非公開・入力の制御文字（監査 F-1・F-6・F-7・F-8）。DB は使わない。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from config import Settings, load_settings
from main import create_app
from schemas import PressRequest

OP = "11111111-1111-4111-8111-111111111111"


def _client(app_env: str) -> TestClient:
    return TestClient(create_app(Settings(app_env=app_env)), raise_server_exceptions=False)


def test_security_headers_on_every_response():
    r = _client("production").get("/health")
    assert r.status_code == 200
    h = r.headers
    assert h["strict-transport-security"].startswith("max-age=31536000")
    assert h["x-content-type-options"] == "nosniff"
    assert h["referrer-policy"] == "no-referrer"
    assert h["cache-control"] == "no-store"
    assert h["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
    assert "server" not in h


def test_docs_hidden_in_production_and_visible_in_development():
    prod = _client("production")
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert prod.get(path).status_code == 404, path
    dev = _client("development")
    assert dev.get("/openapi.json").status_code == 200
    assert dev.get("/docs").status_code == 200


def test_app_env_defaults_to_production(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("DEV_AUTH_BYPASS", "1")
    s = load_settings()
    assert s.is_production and s.dev_auth_bypass is False


@pytest.mark.parametrize("bad", ["water\x00", "wa\x07ter", "Water", "水", "a" * 65, "", "-water", "water;drop"])
def test_action_id_rejects_control_and_unexpected_chars(bad):
    with pytest.raises(ValidationError):
        PressRequest(op_id=OP, action_id=bad)


def test_action_id_accepts_known_shape():
    assert PressRequest(op_id=OP, action_id="no_snack").action_id == "no_snack"
