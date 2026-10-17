"""確定・取り消し・復活・再送・分離のテスト。"""
from __future__ import annotations

import pytest

from tests.helpers import action, cancel, confirm, home, op, press, user_id


# ---- 確定: 行為の種類 × 項目の値の表 ------------------------------------------------
@pytest.mark.parametrize(
    ("action_id", "body", "status", "error"),
    [
        ("water", {"portion": "small"}, 400, "bad_detail"),        # 確定のない行為
        ("veggie", {"weight_kg": 60.0}, 400, "bad_detail"),
        ("breakfast", {"weight_kg": 60.0}, 400, "bad_detail"),     # 食事に体重
        ("weight", {"portion": "small"}, 400, "bad_detail"),       # 体重に量
        ("weight", {}, 400, "bad_request"),                        # どちらも無い
        ("weight", {"weight_kg": 60.0, "portion": "small"}, 400, "bad_request"),   # 両方
        ("weight", {"weight_kg": 64.85}, 400, "bad_request"),      # 小数 2 桁
        ("weight", {"weight_kg": 19.9}, 400, "bad_request"),       # 範囲外
        ("weight", {"weight_kg": 300.1}, 400, "bad_request"),
        ("weight", {"weight_kg": -1}, 400, "bad_request"),
        ("weight", {"weight_kg": "abc"}, 400, "bad_request"),
        ("weight", {"weight_kg": None, "portion": None}, 400, "bad_request"),
        ("breakfast", {"portion": "huge"}, 400, "bad_request"),
        ("weight", {"weight_kg": 60.0, "user_id": "x"}, 400, "bad_request"),   # user_id を受け取る項目は無い
    ],
)
def test_confirm_value_table(api, now, new_sub, action_id, body, status, error):
    sub = new_sub()
    rec = press(api, sub, action_id).json()["record_id"]
    r = confirm(api, sub, rec, **body)
    assert r.status_code == status and r.json()["error"] == error
    # 失敗しても点は付かず、記録は未確定のまま
    assert home(api, sub).json()["progress"]["total_points"] == 10


@pytest.mark.parametrize("w", [20.0, 64.8, 300.0, 65, 100.5])
def test_confirm_weight_accepts_valid(api, now, new_sub, w):
    sub = new_sub()
    rec = press(api, sub, "weight").json()["record_id"]
    r = confirm(api, sub, rec, weight_kg=w)
    assert r.status_code == 200 and r.json()["granted_points"] == 20


def test_confirm_rejects_nan_json(api, now, new_sub):
    sub = new_sub()
    rec = press(api, sub, "weight").json()["record_id"]
    r = api.client.put(f"/records/{rec}/confirm", headers={**api.h(sub), "Content-Type": "application/json"},
                       content=f'{{"op_id": "{op()}", "weight_kg": NaN}}')
    assert r.status_code == 400 and r.json()["error"] == "bad_request"


def test_confirm_wrong_detail_after_value_done(api, now, new_sub):
    """食事の量は 3 択。確定済みの記録に再確定すると値は更新されるが +20 は入らない。"""
    sub = new_sub()
    rec = press(api, sub, "lunch").json()["record_id"]
    assert confirm(api, sub, rec, portion="large").json()["granted_points"] == 20
    again = confirm(api, sub, rec, portion="small").json()
    assert again["granted_points"] == 0 and again["confirm_state"] == "done"
    assert again["progress"]["total_points"] == 30


def test_confirm_cancelled_record_409(api, now, new_sub):
    sub = new_sub()
    rec = press(api, sub, "weight").json()["record_id"]
    cancel(api, sub, rec)
    r = confirm(api, sub, rec, weight_kg=60.0)
    assert r.status_code == 409 and r.json()["error"] == "record_cancelled"


def test_confirm_window_today_and_yesterday_only(api, now, new_sub):
    sub = new_sub()
    now.jst("2026-10-17T23:58:00")
    rec = press(api, sub, "dinner").json()["record_id"]
    now.jst("2026-10-18T00:01:00")                       # 0 時をまたぐ確定は通る（前日）
    assert confirm(api, sub, rec, portion="normal").status_code == 200
    rec2 = press(api, sub, "dinner").json()["record_id"]    # 10/18 分
    now.jst("2026-10-20T09:00:00")                       # 2 日以上前
    r = confirm(api, sub, rec2, portion="normal")
    assert r.status_code == 409 and r.json()["error"] == "confirm_expired"


# ---- 取り消し ----------------------------------------------------------------
def test_cancel_expires_after_window(api, admin, now, new_sub):
    sub = new_sub()
    rec = press(api, sub, "veggie").json()["record_id"]
    admin.execute("update records set active_since = now() - interval '11 minutes' where id = %s", (rec,))
    r = cancel(api, sub, rec)
    assert r.status_code == 409 and r.json()["error"] == "cancel_expired"
    admin.execute("update records set active_since = now() - interval '9 minutes' where id = %s", (rec,))
    assert cancel(api, sub, rec).status_code == 200


def test_cancel_already_cancelled_ignores_deadline(api, admin, now, new_sub):
    sub = new_sub()
    rec = press(api, sub, "veggie").json()["record_id"]
    assert cancel(api, sub, rec).status_code == 200
    admin.execute("update records set active_since = now() - interval '2 hours' where id = %s", (rec,))
    r = cancel(api, sub, rec)             # 別の操作 ID でも、期限を見ずに成功
    assert r.status_code == 200 and r.json()["cancelled"] is True


def test_revive_then_cancel_within_window(api, admin, now, new_sub):
    """朝 8:00 に押す → 取り消し → 8:30 に押し直し → すぐ取り消しが成功する（期限の起点は復活時）。"""
    sub = new_sub()
    rec = press(api, sub, "veggie").json()["record_id"]
    cancel(api, sub, rec)
    admin.execute("update records set active_since = now() - interval '30 minutes', "
                  "cancelled_at = now() - interval '25 minutes' where id = %s", (rec,))
    assert press(api, sub, "veggie").json()["reason"] == "revived"
    assert cancel(api, sub, rec).status_code == 200


def test_delayed_duplicate_revive_is_noop(api, now, new_sub):
    sub = new_sub()
    rec = press(api, sub, "veggie").json()["record_id"]
    cancel(api, sub, rec)
    revive_op = op()
    assert press(api, sub, "veggie", revive_op).json()["reason"] == "revived"
    cancel(api, sub, rec)
    assert press(api, sub, "veggie", revive_op).json()["reason"] == "replayed"
    assert action(home(api, sub).json(), "veggie")["done"] is False


def test_delayed_duplicate_noop_does_not_revive(api, now, new_sub):
    """同日 2 回目の押下（noop）の複製が、取り消した行を復活させない。"""
    sub = new_sub()
    rec = press(api, sub, "dinner").json()["record_id"]
    dup = op()
    assert press(api, sub, "dinner", dup).json()["reason"] == "already_recorded"
    cancel(api, sub, rec)
    assert press(api, sub, "dinner", dup).json()["reason"] == "replayed"
    assert action(home(api, sub).json(), "dinner")["done"] is False


def test_cancelled_repeatable_stays_cancelled(api, now, new_sub):
    sub = new_sub()
    a = press(api, sub, "water").json()["record_id"]
    press(api, sub, "water")
    cancel(api, sub, a)
    st = action(home(api, sub).json(), "water")
    assert st["count"] == 1 and st["done"] is True
    assert home(api, sub).json()["progress"]["total_points"] == 20       # 取り消しても点は残る


# ---- 操作 ID の衝突 ------------------------------------------------------------
def test_op_conflict(api, now, new_sub):
    sub = new_sub()
    o = op()
    rec = press(api, sub, "water", o).json()["record_id"]
    r = press(api, sub, "walk", o)                    # 同じ操作 ID で別の行為
    assert r.status_code == 409 and r.json()["error"] == "op_conflict"
    r = cancel(api, sub, rec, o)                       # 押下の操作 ID を取り消しに使う
    assert r.status_code == 409 and r.json()["error"] == "op_conflict"
    r = confirm(api, sub, rec, o, portion="small")
    assert r.status_code == 409 and r.json()["error"] == "op_conflict"


# ---- 分離 ----------------------------------------------------------------------
def test_isolation_cancel_confirm_replay(api, now, new_sub):
    mika, yuu = new_sub("mika"), new_sub("yuu")
    o = op()
    rec = press(api, mika, "weight", o).json()["record_id"]
    # ゆうが、みかの記録 ID・操作 ID で取り消し・確定・再送
    assert cancel(api, yuu, rec).status_code == 404
    assert confirm(api, yuu, rec, weight_kg=60.0).status_code == 404
    mine = press(api, yuu, "weight", o).json()        # みかの操作 ID を使っても、ゆう自身の新しい押下になる
    assert mine["reason"] == "granted" and mine["record_id"] != rec
    # みかの記録は無傷
    h = home(api, mika).json()
    assert action(h, "weight")["done"] is True and h["progress"]["total_points"] == 10
    # 取り消し済みのみかの記録に、ゆうが確定を送っても同じ（存在を教えない）
    cancel(api, mika, rec)
    r = confirm(api, yuu, rec, weight_kg=60.0)
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_home_and_trend_exclude_other_users(api, now, new_sub):
    mika, yuu = new_sub("mika"), new_sub("yuu")
    rec = press(api, mika, "weight").json()["record_id"]
    confirm(api, mika, rec, weight_kg=64.8)
    press(api, mika, "water")
    h = home(api, yuu).json()
    assert h["progress"]["total_points"] == 0 and h["last_weight_kg"] is None
    assert all(a["count"] == 0 and a["record_id"] is None for a in h["major"] + h["minor"])
    t = api.client.get("/trend", headers=api.h(yuu)).json()
    assert t["current_avg_kg"] is None and all(d["avg_kg"] is None for d in t["days"])
    assert api.client.get("/trend", headers=api.h(mika)).json()["current_avg_kg"] == 64.8


def test_same_state_from_another_session(api, now, new_sub):
    """別の端末（別のトークン・別のキャッシュ）でも同じ点とレベルが見える。"""
    sub = new_sub()
    press(api, sub, "water")
    first = home(api, sub).json()
    api.svc.users._data.clear()                         # 別のセッション（メモリのキャッシュなし）
    assert home(api, sub).json() == first


def test_login_is_idempotent(api, admin, now, new_sub):
    sub = new_sub()
    home(api, sub)
    api.svc.users._data.clear()
    home(api, sub)
    assert admin.execute("select count(*) from users where google_sub = %s", (sub,)).fetchone()[0] == 1
    assert user_id(admin, sub)
