"""テストの共通部品。

DB のテストは実際の Postgres が要る。環境変数 DATABASE_URL（CI では使い捨てのスーパーユーザー接続）の
サーバーに専用の DB を作り、マイグレーションを流して使う。DATABASE_URL が無ければ DB のテストは飛ばす。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict, make_conninfo

import tzdate
from auth import GoogleKeys
from config import Settings
from main import Services, create_app

CLIENT_ID = "test-client.apps.googleusercontent.com"
API_PASSWORD = "pytest_api_only_pw"  # 使い捨て DB の ballon_api 用（秘匿値ではない）
MIGRATIONS = sorted((Path(__file__).resolve().parents[3] / "db" / "migrations").glob("*.sql"))


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def pg():
    base = os.environ.get("DATABASE_URL")
    if not base:
        pytest.skip("DATABASE_URL が無いので DB のテストは飛ばす（CI では Postgres を立てて渡す）")
    name = f"ballon_pytest_{os.getpid()}"
    info = conninfo_to_dict(base)

    def url(dbname: str, user: str | None = None, password: str | None = None) -> str:
        d = {**info, "dbname": dbname}
        if user:
            d["user"], d["password"] = user, password
        return make_conninfo(**d)

    with psycopg.connect(url(info.get("dbname", "postgres")), autocommit=True) as c:
        c.execute(f'drop database if exists "{name}" with (force)')
        c.execute(f'create database "{name}"')
    admin_url = url(name)
    with psycopg.connect(admin_url, autocommit=True) as c:
        for f in MIGRATIONS:
            c.execute(f.read_text())
        c.execute(f"alter role ballon_api password '{API_PASSWORD}'")
    ns = SimpleNamespace(admin_url=admin_url, api_url=url(name, "ballon_api", API_PASSWORD), name=name)
    yield ns
    with psycopg.connect(url(info.get("dbname", "postgres")), autocommit=True) as c:
        c.execute(f'drop database if exists "{name}" with (force)')


@pytest.fixture
def admin(pg):
    """スーパーユーザー（管理用）の接続。テストの準備と確認に使う。"""
    with psycopg.connect(pg.admin_url, autocommit=True) as c:
        yield c


@pytest.fixture
def small_cap(admin):
    """1 日の上限を 3 に差し替える（終わったら 600 に戻す）。"""
    def set_cap(n: int) -> None:
        admin.execute(f"create or replace function _daily_cap() returns integer language sql stable as $$ select {n} $$")
    set_cap(3)
    yield set_cap
    set_cap(600)


# ---------------------------------------------------------------------------
# 偽の Google（鍵・トークン）
# ---------------------------------------------------------------------------
def _new_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


class FakeGoogle:
    """Google の公開鍵一覧の代わり。fetch が呼ばれた回数を数える。"""

    def __init__(self) -> None:
        self.keys: dict[str, object] = {}
        self.fetches = 0
        self.max_age = 3600

    def add(self, kid: str):
        key = _new_key()
        self.keys[kid] = key
        return key

    def fetch(self):
        self.fetches += 1
        jwks = {"keys": []}
        for kid, key in self.keys.items():
            jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
            jwk.update({"kid": kid, "alg": "RS256", "use": "sig"})
            jwks["keys"].append(jwk)
        return jwks, self.max_age


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def sign(key, kid: str, *, sub: str, aud: str = CLIENT_ID, iss: str = "https://accounts.google.com",
         email_verified=True, exp_in: int = 3600, alg: str = "RS256", extra: dict | None = None,
         drop: tuple[str, ...] = ()) -> str:
    now = int(time.time())
    claims = {"iss": iss, "aud": aud, "sub": sub, "email": f"{sub}@example.com",
              "email_verified": email_verified, "iat": now, "exp": now + exp_in}
    claims.update(extra or {})
    for k in drop:
        claims.pop(k, None)
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


@pytest.fixture
def google():
    g = FakeGoogle()
    g.signing = g.add("kid-1")
    return g


# ---------------------------------------------------------------------------
# 時刻（サーバーの現在時刻を差し替える）
# ---------------------------------------------------------------------------
class Now:
    def __init__(self, monkeypatch) -> None:
        self._mp = monkeypatch
        self.set("2026-10-17T22:10:00+00:00")  # 日本時間 10/18 07:10（朝）

    def set(self, iso: str) -> None:
        dt = datetime.fromisoformat(iso).astimezone(UTC)
        self._mp.setattr(tzdate, "utcnow", lambda: dt)

    def jst(self, iso_local: str) -> None:
        """日本時間（+09:00）で指定する。"""
        self.set(iso_local + "+09:00")


@pytest.fixture
def now(monkeypatch):
    return Now(monkeypatch)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
class Api:
    def __init__(self, client: TestClient, svc: Services, google: FakeGoogle) -> None:
        self.client, self.svc, self.google = client, svc, google

    def token(self, sub: str, **kw) -> str:
        return sign(self.google.signing, "kid-1", sub=sub, **kw)

    def h(self, sub: str, offset: int | str | None = 540, **kw) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.token(sub, **kw)}"}
        if offset is not None:
            headers["X-Client-Tz-Offset"] = str(offset)
        return headers


def make_api(pg, google, limiter=None, **settings_kw) -> Api:
    clock = FakeClock()
    # 機能のテストでは頻度制限に当たらないよう緩くする（頻度制限のテストは値を指定して作る）
    limits = {"write_per_sec": 10_000, "write_per_min": 10_000, "read_per_min": 10_000, **settings_kw}
    settings = Settings(database_url=pg.api_url, google_client_id=CLIENT_ID, **limits)
    svc = Services(settings, keys=GoogleKeys(fetch=google.fetch, clock=clock), limiter=limiter)
    svc.clock = clock
    app = create_app(settings, svc)
    return Api(TestClient(app, raise_server_exceptions=False), svc, google)


@pytest.fixture
def api(pg, google, now):
    a = make_api(pg, google)
    yield a
    a.svc.close()


@pytest.fixture
def new_sub():
    """テストごとに別の利用者（sub）を作る。"""
    return lambda prefix="u": f"{prefix}-{uuid.uuid4().hex[:12]}"
