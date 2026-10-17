"""DB動きレビュー資料 視点 1 の時系列を、API 経由で再現する結合テスト。"""
from __future__ import annotations

from tests.helpers import action, cancel, confirm, home, op, press


def test_viewpoint1_timeline(api, now, admin, new_sub):
    mika, yuu = new_sub("mika"), new_sub("yuu")

    # 1〜3. 初回ログインでホームが開く（0 点・Lv1）。再読み込みで変化なし。別の人の記録は出ない
    now.jst("2026-10-17T07:10:00")
    r = home(api, mika)
    assert r.status_code == 200
    h = r.json()
    assert h["progress"] == {"level": 1, "current_points": 0, "required_points": 50,
                             "remaining_points": 50, "total_points": 0, "is_max": False}
    assert h["band"] == "morning" and h["local_date"] == "2026-10-17"
    assert [a["id"] for a in h["major"]] == ["weight", "breakfast", "water"]
    assert len(h["minor"]) == 6 and h["next_action_id"] == "weight" and h["last_weight_kg"] is None
    assert home(api, mika).json() == h
    assert home(api, yuu).json()["progress"]["total_points"] == 0

    # 4〜6. 水を押す。同じ操作 ID の再送は何も変えない。もう一度押すと別の行（×2）
    a1 = op()
    r = press(api, mika, "water", a1)
    assert r.status_code == 200
    j = r.json()
    assert (j["reason"], j["granted_points"], j["progress"]["current_points"]) == ("granted", 10, 10)
    assert j["level_up"] is None
    rr = press(api, mika, "water", a1).json()
    assert rr["reason"] == "replayed" and rr["record_id"] == j["record_id"]
    assert rr["progress"]["total_points"] == 10 and rr["level_up"] is None
    assert press(api, mika, "water").json()["progress"]["total_points"] == 20
    assert action(home(api, mika).json(), "water")["count"] == 2

    # 7〜8. 歩いた・朝食。朝食は未確定（open）
    assert press(api, mika, "walk").json()["progress"]["total_points"] == 30
    bf = press(api, mika, "breakfast").json()
    assert bf["progress"]["total_points"] == 40 and bf["confirm_state"] == "open"

    # 9〜10. 量を選んで確定 → +20、累計 60 で Lv2 に上がる。連打（再送）は点も演出も出ない
    f1 = op()
    c = confirm(api, mika, bf["record_id"], f1, portion="small")
    assert c.status_code == 200
    cj = c.json()
    assert cj["granted_points"] == 20 and cj["confirm_state"] == "done"
    assert cj["level_up"] == {"before": 1, "after": 2}
    assert cj["progress"] == {"level": 2, "current_points": 10, "required_points": 60,
                              "remaining_points": 50, "total_points": 60, "is_max": False}
    c2 = confirm(api, mika, bf["record_id"], f1, portion="small").json()
    assert c2["level_up"] is None and c2["progress"]["total_points"] == 60

    # 11. 朝食の「済」をもう一度 → 行は増えず点なし（already_recorded）。確定済みなので done
    again = press(api, mika, "breakfast").json()
    assert again["reason"] == "already_recorded" and again["granted_points"] == 0
    assert again["confirm_state"] == "done" and again["record_id"] == bf["record_id"]
    assert again["progress"]["total_points"] == 60

    # 12〜13. 昼食を押して「あとで」→ 済を押すと open のまま（先のページを開き直す）。+10 は入らない
    lunch = press(api, mika, "lunch").json()
    assert lunch["progress"]["total_points"] == 70
    again = press(api, mika, "lunch").json()
    assert again["reason"] == "already_recorded" and again["confirm_state"] == "open"
    assert again["progress"]["total_points"] == 70

    # 14〜19. 野菜を間違えて押す → 取り消す（点は残る）→ 押し直し（点なしで復活）→ 取り消し → 複製が届いても復活しない
    v = press(api, mika, "veggie").json()
    assert v["progress"]["total_points"] == 80
    assert cancel(api, mika, v["record_id"]).json()["progress"]["total_points"] == 80
    assert action(home(api, mika).json(), "veggie")["done"] is False
    a9 = op()
    rv = press(api, mika, "veggie", a9).json()
    assert (rv["reason"], rv["granted_points"], rv["record_id"]) == ("revived", 0, v["record_id"])
    assert rv["progress"]["total_points"] == 80
    assert press(api, mika, "veggie", a9).json()["reason"] == "replayed"
    assert cancel(api, mika, v["record_id"]).status_code == 200      # 復活直後の取り消しも成功
    assert press(api, mika, "veggie", a9).json()["reason"] == "replayed"   # 遅れて届いた複製
    assert action(home(api, mika).json(), "veggie")["done"] is False      # 復活していない

    # 20. ゆうがみかの記録を取り消そうとしても not_found（存在も教えない）
    r = cancel(api, yuu, v["record_id"])
    assert r.status_code == 404 and r.json()["error"] == "not_found"

    # 21〜25. 体重: 確定 +20 で Lv3 → 取り消し（推移から外れる）→ 押し直し（regrant_blocked）→ 再確定は点なし
    now.jst("2026-10-17T18:30:00")
    w = press(api, mika, "weight").json()
    assert w["progress"]["total_points"] == 90 and w["confirm_state"] == "open"
    cw = confirm(api, mika, w["record_id"], weight_kg=64.8).json()
    assert cw["level_up"] == {"before": 2, "after": 3}
    assert cw["progress"]["level"] == 3 and cw["progress"]["current_points"] == 0
    assert home(api, mika).json()["last_weight_kg"] == 64.8
    assert cancel(api, mika, w["record_id"]).status_code == 200
    assert home(api, mika).json()["last_weight_kg"] is None
    rw = press(api, mika, "weight").json()
    assert rw["reason"] == "revived" and rw["confirm_state"] == "regrant_blocked"
    cw2 = confirm(api, mika, w["record_id"], weight_kg=64.6).json()
    assert cw2["granted_points"] == 0 and cw2["confirm_state"] == "done"
    assert cw2["progress"]["total_points"] == 110

    # 26. 夕食
    dn = press(api, mika, "dinner").json()
    assert dn["progress"]["total_points"] == 120 and dn["progress"]["current_points"] == 10

    # 27〜29. 0 時を過ぎると日付が変わり、夕食が今日の一手に戻る。夜食なしを押す → 同じボタンの 2 回目は点なし
    now.jst("2026-10-18T00:05:00")
    h = home(api, mika).json()
    assert h["local_date"] == "2026-10-18" and h["band"] == "night"
    assert action(h, "dinner")["done"] is False and h["next_action_id"] == "dinner"
    assert h["progress"]["total_points"] == 120
    assert press(api, mika, "no_snack").json()["progress"]["total_points"] == 130
    assert press(api, mika, "no_snack").json()["reason"] == "already_recorded"

    # 30〜32. 朝の盤面。端末の時計は使わない。時差を選ぶと前日の枠が取れる（前後 1 日ずつまで）
    now.jst("2026-10-18T07:05:00")
    h = home(api, mika).json()
    assert h["band"] == "morning" and h["next_action_id"] == "weight"
    assert press(api, mika, "breakfast").json()["progress"]["total_points"] == 140
    now.jst("2026-10-18T07:08:00")
    r = press(api, mika, "no_snack", offset=-720).json()
    assert r["reason"] == "granted" and r["progress"]["total_points"] == 150

    # ゆうの点は変わらない（分離）
    assert home(api, yuu).json()["progress"]["total_points"] == 0
    # 台帳: 操作は record_ops に 1 行ずつ。noop（同日 2 回目）も残る
    kinds = [k for (k,) in admin.execute(
        "select kind from record_ops o join users u on u.id = o.user_id where u.google_sub = %s", (mika,))]
    assert kinds.count("noop") == 3 and kinds.count("revive") == 2


def test_daily_cap_counts_repeatable_only(api, now, small_cap, new_sub):
    """1 日の上限は repeatable の行だけ。上限に当たっても 1 日 1 回の行為は押せる。再送しても通らない。"""
    sub = new_sub()
    for _ in range(3):
        assert press(api, sub, "water").status_code == 200
    capped_op = op()
    r = press(api, sub, "water", capped_op)
    assert r.status_code == 429 and r.json()["error"] == "daily_cap"
    assert "Retry-After" not in r.headers
    assert press(api, sub, "water", capped_op).json()["error"] == "daily_cap"   # 再送しても通らない
    assert press(api, sub, "dinner").status_code == 200                          # 1 日 1 回は対象外
    assert press(api, sub, "walk").status_code == 429                            # 別の repeatable も同じ上限
    # 翌日は押せる
    now.jst("2026-10-19T08:00:00")
    assert press(api, sub, "water").status_code == 200


def test_ops_ledger_cap(api, now, small_cap, new_sub):
    """取り消し・復活・確定・noop の台帳にも 1 日の上限がある（超えたら daily_cap）。"""
    sub = new_sub()
    rec = press(api, sub, "dinner").json()["record_id"]
    for _ in range(3):
        assert press(api, sub, "dinner").json()["reason"] == "already_recorded"   # noop が 3 行
    r = press(api, sub, "dinner")
    assert r.status_code == 429 and r.json()["error"] == "daily_cap"
    assert cancel(api, sub, rec).json()["error"] == "daily_cap"
    assert press(api, sub, "water").status_code == 200   # 押す（repeatable）は台帳の上限の対象外
