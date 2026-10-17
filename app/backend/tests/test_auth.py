"""ID トークンの検証・時差・頻度制限・エラー形式。"""
from __future__ import annotations

import base64
import json
import logging
import time

import psycopg
import pytest
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from auth import GoogleKeys
from config import Settings, load_settings
from main import Services, client_ip, create_app
from ratelimit import RateLimiter
from tests.conftest import CLIENT_ID, FakeClock, FakeGoogle, make_api, sign
from tests.helpers import home, op, press


def _status(api, sub, **kw):
    r = api.client.get("/home", headers=api.h(sub, **kw))
    return r.status_code, r.json().get("error")


# ---- 偽のトークンは通らない -----------------------------------------------------
def test_auth_missing_or_garbage(api, now):
    assert api.client.get("/home", headers={"X-Client-Tz-Offset": "540"}).status_code == 401
    for bad in ("Bearer", "Bearer abc", "Bearer a.b.c", "Basic Zm9vOmJhcg==", "Bearer "):
        r = api.client.get("/home", headers={"Authorization": bad, "X-Client-Tz-Offset": "540"})
        assert r.status_code == 401 and r.json()["error"] == "unauthorized", bad


def test_auth_rejects_tampered_signature(api, now, new_sub):
    t = api.token(new_sub())
    head, payload, sig = t.split(".")
    other = api.token(new_sub())
    forged_payload = other.split(".")[1]
    for forged in (f"{head}.{forged_payload}.{sig}", f"{head}.{payload}.{sig[:-4]}AAAA"):
        r = api.client.get("/home", headers={"Authorization": f"Bearer {forged}", "X-Client-Tz-Offset": "540"})
        assert r.status_code == 401 and r.json()["error"] == "unauthorized"


def test_auth_rejects_alg_none(api, now, new_sub):
    def b64(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    now_s = int(time.time())
    t = ".".join([b64({"alg": "none", "kid": "kid-1", "typ": "JWT"}),
                  b64({"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "x", "email": "x@x",
                       "email_verified": True, "exp": now_s + 600}), ""])
    assert _status_with_token(api, t) == (401, "unauthorized")


def test_auth_rejects_hs256_with_public_key_as_secret(api, now, google):
    """RS256 に固定: 公開鍵を共有秘密にした HS256 のトークン（アルゴリズム差し替え）を通さない。"""
    pub = google.signing.public_key().public_bytes(serialization.Encoding.PEM,
                                                   serialization.PublicFormat.SubjectPublicKeyInfo)
    now_s = int(time.time())
    claims = {"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "x", "email": "x@x",
              "email_verified": True, "exp": now_s + 600}
    t = _hs256(claims, pub)
    assert _status_with_token(api, t) == (401, "unauthorized")


def _hs256(claims, secret: bytes) -> str:
    import hashlib
    import hmac

    def b64(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    h = b64(json.dumps({"alg": "HS256", "kid": "kid-1", "typ": "JWT"}).encode())
    p = b64(json.dumps(claims).encode())
    sig = hmac.new(secret, f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{b64(sig)}"


def _status_with_token(api, token):
    r = api.client.get("/home", headers={"Authorization": f"Bearer {token}", "X-Client-Tz-Offset": "540"})
    return r.status_code, r.json().get("error")


def test_auth_rejects_foreign_issuer(api, now, new_sub):
    assert _status(api, new_sub(), iss="https://evil.example.com") == (401, "unauthorized")
    assert _status(api, new_sub(), iss="https://accounts.google.com.evil.example") == (401, "unauthorized")


def test_auth_accepts_both_google_issuer_forms(api, now, new_sub):
    assert _status(api, new_sub(), iss="https://accounts.google.com")[0] == 200
    assert _status(api, new_sub(), iss="accounts.google.com")[0] == 200


def test_auth_rejects_wrong_audience(api, now, new_sub):
    assert _status(api, new_sub(), aud="other-app.apps.googleusercontent.com") == (401, "unauthorized")


def test_auth_rejects_email_not_verified(api, now, new_sub):
    assert _status(api, new_sub(), email_verified=False) == (401, "unauthorized")
    assert _status(api, new_sub(), email_verified="false") == (401, "unauthorized")
    assert _status(api, new_sub(), drop=("email_verified",)) == (401, "unauthorized")
    assert _status(api, new_sub(), email_verified="true")[0] == 200     # 文字列の "true" も真として受ける


def test_auth_requires_sub_and_email(api, now, new_sub):
    assert _status(api, new_sub(), drop=("sub",)) == (401, "unauthorized")
    assert _status(api, new_sub(), extra={"sub": ""}) == (401, "unauthorized")
    assert _status(api, new_sub(), drop=("email",)) == (401, "unauthorized")


def test_auth_expired_and_leeway(api, now, new_sub):
    assert _status(api, new_sub(), exp_in=-120) == (401, "token_expired")
    assert _status(api, new_sub(), exp_in=-10)[0] == 200                  # 許容 30 秒以内
    nbf_future = int(time.time()) + 600
    assert _status(api, new_sub(), extra={"nbf": nbf_future}) == (401, "unauthorized")


def test_auth_rejects_token_signed_by_unknown_key(api, now, new_sub):
    """JWKS に無い鍵（攻撃者の鍵）で署名したものは、kid を偽っても通らない。"""
    attacker = FakeGoogle().add("kid-1")
    t = sign(attacker, "kid-1", sub=new_sub())
    assert _status_with_token(api, t) == (401, "unauthorized")


def test_auth_no_client_id_configured_rejects_all(pg, google, now, new_sub):
    a = make_api(pg, google)
    a.svc.settings = Settings(database_url=pg.api_url, google_client_id="")
    assert _status(a, new_sub()) == (401, "unauthorized")


# ---- 鍵の取得（kid の再取得は 60 秒に 1 回） --------------------------------------
def test_unknown_kid_refetches_at_most_once_per_minute(api, now, google, new_sub):
    clock = api.svc.clock
    assert _status(api, new_sub())[0] == 200
    base = google.fetches
    attacker = FakeGoogle().add("kid-x")
    t = sign(attacker, "kid-x", sub="evil")
    for _ in range(20):                    # 未知の kid を連発しても外向きの取得は増えない
        assert _status_with_token(api, t) == (401, "unauthorized")
    assert google.fetches == base
    clock.t += 61                          # 60 秒たてば 1 回だけ再取得する
    assert _status_with_token(api, t) == (401, "unauthorized")
    assert google.fetches == base + 1
    for _ in range(5):
        _status_with_token(api, t)
    assert google.fetches == base + 1


def test_key_rotation_picked_up_with_one_refetch(api, now, google, new_sub):
    """Google が鍵を入れ替えた直後に未知の kid が来ても、1 回の再取得で通る。"""
    assert _status(api, new_sub())[0] == 200
    base = google.fetches
    new_key = google.add("kid-2")
    api.svc.clock.t += 120
    t = sign(new_key, "kid-2", sub=new_sub())
    assert _status_with_token(api, t)[0] == 200
    assert google.fetches == base + 1


def test_keys_cached_until_max_age(api, now, google, new_sub):
    assert _status(api, new_sub())[0] == 200
    base = google.fetches
    for _ in range(5):
        assert _status(api, new_sub())[0] == 200
    assert google.fetches == base                       # キャッシュ内は取得しない
    api.svc.clock.t += 3601
    assert _status(api, new_sub())[0] == 200
    assert google.fetches == base + 1


def test_jwks_fetch_failure_without_keys_is_503(pg, now, new_sub):
    def boom():
        raise OSError("network")
    clock = FakeClock()
    settings = Settings(database_url=pg.api_url, google_client_id=CLIENT_ID)
    svc = Services(settings, keys=GoogleKeys(fetch=boom, clock=clock))
    c = TestClient(create_app(settings, svc), raise_server_exceptions=False)
    g = FakeGoogle()
    key = g.add("kid-1")
    r = c.get("/home", headers={"Authorization": f"Bearer {sign(key, 'kid-1', sub=new_sub())}",
                                "X-Client-Tz-Offset": "540"})
    assert r.status_code == 503 and r.json()["error"] == "service_unavailable"


def test_jwks_fetch_failure_keeps_stale_keys(api, now, google, new_sub):
    assert _status(api, new_sub())[0] == 200

    def boom():
        raise OSError("network")
    api.svc.keys._fetch = boom
    api.svc.clock.t += 7200
    assert _status(api, new_sub())[0] == 200            # 古い鍵で続ける


# ---- 頻度制限 -------------------------------------------------------------------
def test_write_rate_limit_per_second(pg, google, now, new_sub):
    clock = FakeClock()
    a = make_api(pg, google, limiter=RateLimiter(clock=clock), write_per_sec=3, write_per_min=300)
    sub = new_sub()
    for _ in range(3):
        assert press(a, sub, "water").status_code == 200
    fourth_op = op()
    r = press(a, sub, "water", fourth_op)
    assert r.status_code == 429 and r.json()["error"] == "rate_limited"
    assert int(r.headers["Retry-After"]) >= 1
    clock.t += 1.1                                       # 待てば、同じ操作 ID で再送できる
    assert press(a, sub, "water", fourth_op).status_code == 200
    assert home(a, sub).json()["progress"]["total_points"] == 40     # 弾かれた分は付いていない


def test_rate_limit_per_minute_and_per_user(pg, google, now, new_sub):
    clock = FakeClock()
    a = make_api(pg, google, limiter=RateLimiter(clock=clock), write_per_sec=100, write_per_min=5, read_per_min=4)
    u1, u2 = new_sub(), new_sub()
    for _ in range(5):
        assert press(a, u1, "water").status_code == 200
        clock.t += 2
    r = press(a, u1, "water")
    assert r.status_code == 429 and r.json()["error"] == "rate_limited" and int(r.headers["Retry-After"]) >= 1
    assert press(a, u2, "water").status_code == 200       # ほかの利用者は影響を受けない
    for _ in range(4):
        assert home(a, u2).status_code == 200
    assert home(a, u2).status_code == 429


def test_expired_tokens_are_not_counted(pg, google, now, new_sub):
    """期限切れの 401 は頻度制限に数えない（講義開始 1 時間後にいっせいに切れても止まらない）。"""
    a = make_api(pg, google, limiter=RateLimiter(clock=FakeClock()), auth_fail_per_min=3)
    for _ in range(30):
        assert _status(a, new_sub(), exp_in=-3600) == (401, "token_expired")


def test_failed_auth_limited_per_ip_but_success_is_not(pg, google, now, new_sub):
    a = make_api(pg, google, limiter=RateLimiter(clock=FakeClock()), auth_fail_per_min=3)
    bad = {"Authorization": "Bearer a.b.c", "X-Client-Tz-Offset": "540", "X-Forwarded-For": "1.1.1.1, 9.9.9.9:4000"}
    codes = [a.client.get("/home", headers=bad).status_code for _ in range(5)]
    assert codes == [401, 401, 401, 429, 429]
    other_ip = {**bad, "X-Forwarded-For": "1.1.1.1, 8.8.8.8"}
    assert a.client.get("/home", headers=other_ip).status_code == 401           # 別の IP は別枠
    # 同じ IP でも、認証に成功したリクエストには IP 制限を掛けない（教室の共有 IP）
    ok = {**a.h(new_sub()), "X-Forwarded-For": "1.1.1.1, 9.9.9.9:4000"}
    assert a.client.get("/home", headers=ok).status_code == 200


def test_health_and_options_not_counted(pg, google, now):
    a = make_api(pg, google, limiter=RateLimiter(clock=FakeClock()), auth_fail_per_min=1, read_per_min=1)
    for _ in range(50):
        assert a.client.get("/health").json() == {"status": "ok"}
        r = a.client.options("/records", headers={"Origin": "http://localhost:3000",
                                                  "Access-Control-Request-Method": "POST"})
        assert r.status_code == 200


@pytest.mark.parametrize(
    ("xff", "host", "expected"),
    [
        ("1.2.3.4", "h", "1.2.3.4"),
        ("6.6.6.6, 1.2.3.4", "h", "1.2.3.4"),                # 先頭は端末が書ける値なので使わない
        ("6.6.6.6, 1.2.3.4:5678", "h", "1.2.3.4"),          # ポート付き IPv4
        ("[2001:db8::1]:443", "h", "2001:db8::1"),           # ポート付き IPv6
        ("2001:db8::1", "h", "2001:db8::1"),                 # ポートなしの IPv6
        ("", "10.0.0.9", "10.0.0.9"),
    ],
)
def test_client_ip_uses_last_forwarded_entry(xff, host, expected):
    class R:
        headers = {"x-forwarded-for": xff} if xff else {}

        class client:
            pass
    R.client.host = host
    assert client_ip(R) == expected


# ---- 時差 -----------------------------------------------------------------------
@pytest.mark.parametrize("bad", [None, "", "abc", "841", "-721", "540.5", "5 40", "1e3", "+540", "99999"])
def test_invalid_offset_400(api, now, new_sub, bad):
    r = api.client.get("/home", headers=api.h(new_sub(), offset=bad))
    assert r.status_code == 400 and r.json()["error"] == "invalid_offset"


@pytest.mark.parametrize("ok", [-720, 0, 540, 840])
def test_valid_offset_range(api, now, new_sub, ok):
    assert api.client.get("/home", headers=api.h(new_sub(), offset=ok)).status_code == 200


def test_local_date_and_band_table(api, now, new_sub):
    """サーバー時刻を固定したときの local_date と時間帯の表。"""
    sub = new_sub()
    table = [
        ("2026-10-17T03:59:00+00:00", 0, "2026-10-17", "night"),
        ("2026-10-17T04:00:00+00:00", 0, "2026-10-17", "morning"),
        ("2026-10-17T09:59:00+00:00", 0, "2026-10-17", "morning"),
        ("2026-10-17T10:00:00+00:00", 0, "2026-10-17", "noon"),
        ("2026-10-17T15:59:00+00:00", 0, "2026-10-17", "noon"),
        ("2026-10-17T16:00:00+00:00", 0, "2026-10-17", "night"),
        ("2026-10-17T23:59:00+00:00", 0, "2026-10-17", "night"),
        ("2026-10-17T23:59:00+00:00", 540, "2026-10-18", "morning"),
        ("2026-10-17T14:00:00+00:00", 540, "2026-10-17", "night"),
        ("2026-10-17T00:30:00+00:00", -720, "2026-10-16", "noon"),
        ("2026-10-17T22:00:00+00:00", 840, "2026-10-18", "noon"),
    ]
    for iso, off, d, band in table:
        now.set(iso)
        h = home(api, sub, offset=off).json()
        assert (h["local_date"], h["band"]) == (d, band), (iso, off)


def test_parse_offset_rejects_non_ascii_digits():
    from errors import ApiError
    from tzdate import parse_offset
    with pytest.raises(ApiError):
        parse_offset("０")
    assert parse_offset(" 540 ") == 540


def test_client_clock_is_not_used(api, now, new_sub):
    """端末の時計に相当するヘッダ（Date など）を送っても日付は変わらない。"""
    sub = new_sub()
    h = api.h(sub)
    h["Date"] = "Sat, 25 Oct 2025 07:06:00 GMT"
    assert api.client.get("/home", headers=h).json()["local_date"] == "2026-10-18"


# ---- 開発用の認証迂回 ------------------------------------------------------------
def test_dev_auth_bypass_only_when_enabled(pg, google, now, new_sub):
    off = make_api(pg, google)
    r = off.client.get("/home", headers={"Authorization": "Bearer dev:alice", "X-Client-Tz-Offset": "540"})
    assert r.status_code == 401
    on = make_api(pg, google, dev_auth_bypass=True)
    sub = new_sub()
    r = on.client.get("/home", headers={"Authorization": f"Bearer dev:{sub}", "X-Client-Tz-Offset": "540"})
    assert r.status_code == 200
    for bad in ("dev:", "dev:a b", "dev:" + "x" * 65, "dev:../x"):
        r = on.client.get("/home", headers={"Authorization": f"Bearer {bad}", "X-Client-Tz-Offset": "540"})
        assert r.status_code == 401


def test_dev_auth_bypass_disabled_in_production(monkeypatch, caplog):
    monkeypatch.setenv("DEV_AUTH_BYPASS", "1")
    monkeypatch.setenv("APP_ENV", "production")
    with caplog.at_level(logging.WARNING, logger="ballon"):
        s = load_settings()
    assert s.dev_auth_bypass is False and s.is_production
    assert "DEV_AUTH_BYPASS" in caplog.text
    monkeypatch.setenv("APP_ENV", "development")
    assert load_settings().dev_auth_bypass is True


# ---- エラー形式・堅牢性 -----------------------------------------------------------
def test_error_shape_for_unknown_route_and_method(api, now, new_sub):
    r = api.client.get("/nope")
    assert r.status_code == 404 and set(r.json()) == {"error", "message"} and r.json()["error"] == "not_found"
    r = api.client.delete("/records", headers=api.h(new_sub()))
    assert r.status_code == 405 and set(r.json()) == {"error", "message"}


def test_validation_errors_are_400_without_details(api, now, new_sub):
    sub = new_sub()
    for body in ({}, {"op_id": "not-a-uuid", "action_id": "water"}, {"op_id": op()}, {"op_id": op(), "action_id": ""},
                 {"op_id": op(), "action_id": "water", "user_id": "x"}):
        r = api.client.post("/records", json=body, headers=api.h(sub))
        assert r.status_code == 400 and set(r.json()) == {"error", "message"}
    r = api.client.post("/records/not-a-uuid/cancel", json={"op_id": op()}, headers=api.h(sub))
    assert r.status_code == 400


def test_unexpected_error_does_not_leak(api, now, new_sub, monkeypatch):
    import db

    def boom(self, local_date):
        raise RuntimeError("secret-internal-detail")
    monkeypatch.setattr(db.Repo, "home", boom)
    r = api.client.get("/home", headers=api.h(new_sub()))
    assert r.status_code == 500 and "secret" not in r.text
    assert r.json() == {"error": "internal_error", "message": "うまく処理できませんでした。"}


def test_db_down_is_503(pg, google, now, new_sub):
    class DownPool:
        def connection(self):
            raise psycopg.OperationalError("connection refused: postgres://user:pw@host")
        def close(self):
            pass
    settings = Settings(database_url="x", google_client_id=CLIENT_ID)
    svc = Services(settings, keys=GoogleKeys(fetch=google.fetch, clock=FakeClock()), pool=DownPool())
    c = TestClient(create_app(settings, svc), raise_server_exceptions=False)
    key = google.signing
    r = c.get("/home", headers={"Authorization": f"Bearer {sign(key, 'kid-1', sub=new_sub())}",
                                "X-Client-Tz-Offset": "540"})
    assert r.status_code == 503 and r.json()["error"] == "service_unavailable" and "pw" not in r.text


def test_cors_allows_only_configured_origin(pg, google, now):
    a = make_api(pg, google, allowed_origins=["https://app.example.com"])
    ok = a.client.options("/home", headers={"Origin": "https://app.example.com",
                                            "Access-Control-Request-Method": "GET",
                                            "Access-Control-Request-Headers": "authorization,x-client-tz-offset"})
    assert ok.headers.get("access-control-allow-origin") == "https://app.example.com"
    ng = a.client.options("/home", headers={"Origin": "https://evil.example.com",
                                            "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in ng.headers
    r = a.client.get("/health", headers={"Origin": "https://app.example.com"})
    assert "Retry-After" in r.headers.get("access-control-expose-headers", "")
