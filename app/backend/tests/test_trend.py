"""体重の 7 日平均（欠測日・取り消し・割り切れない値・窓の端）。"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from tests.helpers import cancel, confirm, home, press, user_id
from trend import build_trend

T = date(2026, 10, 17)


def pts(**kw):
    """pts(d0=64.0, d2=65.0) → 今日から n 日前の体重。"""
    return [{"date": (T - timedelta(days=int(k[1:]))).isoformat(), "kg": v} for k, v in kw.items()]


@pytest.mark.parametrize(
    ("points", "current", "oldest", "diff"),
    [
        ([], None, None, None),                                          # 1 件も無い
        (pts(d0=64.0), 64.0, None, None),                                # 今日だけ
        (pts(d0=64.0, d2=65.0, d6=66.0), 65.0, None, None),              # 欠測日があっても出る（値のある日だけで平均）
        (pts(d0=64.0, d7=70.0), 64.0, None, None),                       # 7 日より前は窓の外
        (pts(d0=64.0, d1=64.0, d2=65.0), 64.3, None, None),              # 64.333… → 64.3
        (pts(d0=64.0, d1=64.5), 64.3, None, None),                       # 64.25 → 四捨五入（5 は切り上げ）で 64.3
        (pts(d0=68.0, d27=70.0), 68.0, 70.0, -2.0),                      # 左端（27 日前）との差
        (pts(d0=68.0, d33=70.0), 68.0, 70.0, -2.0),                      # 左端の窓の最古（33 日前）まで使う
        (pts(d0=68.0, d34=70.0), 68.0, None, None),                      # 34 日前は使わない
        (pts(d27=70.0), None, 70.0, None),                               # 今日が空なら差は出ない
    ],
)
def test_build_trend_table(points, current, oldest, diff):
    t = build_trend(points, T)
    assert len(t["days"]) == 28 and t["days"][-1]["date"] == T and t["days"][0]["date"] == T - timedelta(days=27)
    assert (t["current_avg_kg"], t["four_weeks_ago_avg_kg"], t["diff_kg"]) == (current, oldest, diff)


def test_build_trend_rolling_window_edges():
    t = build_trend(pts(d3=60.0), T)
    by = {d["date"]: d["avg_kg"] for d in t["days"]}
    assert by[T - timedelta(days=3)] == 60.0 and by[T] == 60.0           # 3 日前の体重は今日の窓（7 日）に入る
    t = build_trend(pts(d7=60.0), T)
    by = {d["date"]: d["avg_kg"] for d in t["days"]}
    assert by[T] is None and by[T - timedelta(days=1)] == 60.0           # 7 日前のものは、6 日前以降の窓に入る


def test_trend_via_api_excludes_cancelled_and_clears_on_revive(api, admin, now, new_sub):
    sub = new_sub()
    w = press(api, sub, "weight").json()["record_id"]
    confirm(api, sub, w, weight_kg=64.0)
    uid = user_id(admin, sub)
    # 2 日前・3 日前の体重を直接入れる（過去の記録）
    for back, kg in ((2, 65.0), (3, 66.0)):
        d = date(2026, 10, 18) - timedelta(days=back)
        admin.execute("insert into records(user_id, action_id, local_date, slot_date, confirm_points, weight_kg) "
                      "values (%s, 'weight', %s, %s, 20, %s)", (uid, d, d, kg))
    t = api.client.get("/trend", headers=api.h(sub)).json()
    assert t["current_avg_kg"] == 65.0 and t["days"][-1]["avg_kg"] == 65.0
    cancel(api, sub, w)                                                    # 取り消した体重は平均から外れる
    assert api.client.get("/trend", headers=api.h(sub)).json()["current_avg_kg"] == 65.5
    press(api, sub, "weight")                                              # 復活しても古い体重は戻らない
    assert api.client.get("/trend", headers=api.h(sub)).json()["current_avg_kg"] == 65.5
    confirm(api, sub, w, weight_kg=63.0)
    assert api.client.get("/trend", headers=api.h(sub)).json()["current_avg_kg"] == 64.7    # (63+65+66)/3
    assert home(api, sub).json()["last_weight_kg"] == 63.0
