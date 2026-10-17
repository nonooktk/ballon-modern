"""デモ用リセット（POST /me/reset）。本人の明示操作だけ・他の利用者は無傷。"""
from __future__ import annotations

import psycopg
import pytest
from psycopg import errors

from tests.helpers import action, confirm, home, op, press, user_id


def reset(api, sub, op_id=None):
    return api.client.post("/me/reset", json={"op_id": op_id or op()}, headers=api.h(sub))


def _seed(api, sub):
    rec = press(api, sub, "weight").json()["record_id"]
    confirm(api, sub, rec, weight_kg=64.8)
    press(api, sub, "water")
    press(api, sub, "dinner")


def test_reset_only_affects_self(api, admin, now, new_sub):
    a, b = new_sub("a"), new_sub("b")
    _seed(api, a)
    _seed(api, b)
    before_b = home(api, b).json()
    r = reset(api, a)
    assert r.status_code == 200
    j = r.json()
    assert j["deleted"] == 3 and j["level"] == 1 and j["total_points"] == 0
    assert j["current_points"] == 0 and j["required_points"] == 50 and j["is_max"] is False
    assert home(api, b).json() == before_b                       # B は無傷
    assert admin.execute("select count(*) from users where google_sub = %s", (a,)).fetchone()[0] == 1  # users は残る
    n_b = admin.execute("select count(*) from records where user_id = %s", (user_id(admin, b),)).fetchone()[0]
    assert n_b == 3


def test_press_after_reset_grants_again(api, now, new_sub):
    sub = new_sub()
    _seed(api, sub)
    reset(api, sub)
    h = home(api, sub).json()
    assert h["progress"]["total_points"] == 0 and h["last_weight_kg"] is None
    assert all(not a["done"] and a["count"] == 0 for a in h["major"] + h["minor"])
    r = press(api, sub, "dinner").json()
    assert r["reason"] == "granted" and r["granted_points"] == 10
    assert action(home(api, sub).json(), "dinner")["done"] is True


def test_reset_replay_deletes_nothing(api, now, new_sub):
    sub = new_sub()
    _seed(api, sub)
    o = op()
    assert reset(api, sub, o).json()["deleted"] == 3
    press(api, sub, "water")
    again = reset(api, sub, o)                                    # 同じ op_id の再送
    assert again.status_code == 200 and again.json()["deleted"] == 0
    assert again.json()["total_points"] == 10                     # 再送後に押した分は消えない
    assert reset(api, sub).json()["deleted"] == 1                 # 新しい op_id は消す


def test_reset_op_id_conflict_with_other_kind(api, now, new_sub):
    sub = new_sub()
    o = op()
    press(api, sub, "water", o)
    r = reset(api, sub, o)
    assert r.status_code == 409 and r.json()["error"] == "op_conflict"


def test_reset_validation_and_auth(api, now, new_sub):
    sub = new_sub()
    for body in ({}, {"op_id": "x"}, {"op_id": op(), "user_id": "y"}):
        assert api.client.post("/me/reset", json=body, headers=api.h(sub)).status_code == 400
    assert api.client.post("/me/reset", json={"op_id": op()}).status_code == 401


def test_reset_counts_as_write_for_rate_limit(pg, google, now, new_sub):
    from ratelimit import RateLimiter
    from tests.conftest import FakeClock, make_api
    a = make_api(pg, google, limiter=RateLimiter(clock=FakeClock()), write_per_sec=2)
    sub = new_sub()
    assert [reset(a, sub).status_code for _ in range(3)] == [200, 200, 429]


def test_direct_delete_still_denied_for_api_role(pg):
    with psycopg.connect(pg.api_url, autocommit=True) as c:
        for sql in ("delete from records", "delete from record_ops", "truncate records"):
            with pytest.raises(errors.InsufficientPrivilege):
                c.execute(sql)


def test_reset_function_privileges(admin):
    assert admin.execute("select has_function_privilege('ballon_api', 'app_reset_me(uuid, uuid)', 'execute')"
                         ).fetchone()[0] is True
    assert admin.execute("select has_function_privilege('public', 'app_reset_me(uuid, uuid)', 'execute')"
                         ).fetchone()[0] is False
