"""DB の関数・トリガ・権限・制約のテスト（実際の Postgres）。"""
from __future__ import annotations

import threading
from datetime import date
from uuid import uuid4

import psycopg
import pytest
from psycopg import errors
from psycopg_pool import ConnectionPool

from db import Repo, login
from errors import ApiError
from tests import probe
from tests.helpers import home, press, user_id

TODAY = date(2026, 10, 17)


@pytest.fixture
def repo_of(pg):
    pool = ConnectionPool(pg.api_url, min_size=1, max_size=12, open=True)

    def make(sub: str) -> Repo:
        return Repo(pool, login(pool, sub, f"{sub}@example.com"))

    yield make
    pool.close()


# ---- ロール権限（role_probe） ------------------------------------------------
def test_role_probe_healthy(pg):
    assert probe.run_probe(pg.admin_url) == []


def test_role_probe_detects_leaked_privilege(pg, admin):
    """検査が空振りして通る事故を避ける: 権限を付けた比較用の状態では赤になる。外せば緑に戻る。"""
    admin.execute("grant select on records to ballon_api")
    try:
        assert any("records" in p for p in probe.run_probe(pg.admin_url))
    finally:
        admin.execute("revoke select on records from ballon_api")
    assert probe.run_probe(pg.admin_url) == []


def test_role_probe_detects_public_function(pg, admin):
    admin.execute("create function _leak() returns int language sql as $$ select 1 $$")
    try:
        # スーパーユーザーが作った関数には既定で全員の実行権限が付く。それが検出されること
        assert any("_leak" in p for p in probe.run_probe(pg.admin_url))
    finally:
        admin.execute("drop function _leak()")
    assert probe.run_probe(pg.admin_url) == []


def test_api_role_cannot_touch_tables(pg):
    with psycopg.connect(pg.api_url, autocommit=True) as c:
        for t in probe.TABLES:
            with pytest.raises(errors.InsufficientPrivilege):
                c.execute(f"select * from {t}")
        with pytest.raises(errors.InsufficientPrivilege):
            c.execute("truncate records")
        assert c.execute("select app_total(gen_random_uuid())").fetchone()[0]["level"] == 1


def test_api_role_cannot_call_internal_helpers(pg):
    with psycopg.connect(pg.api_url, autocommit=True) as c:
        for sql in ("select _progress(gen_random_uuid())", "select _daily_cap()",
                    "select _err('x')", "select _lock(gen_random_uuid())"):
            with pytest.raises(errors.InsufficientPrivilege):
                c.execute(sql)


def test_stranger_role_cannot_connect(pg, admin):
    """ballon_owner / ballon_api 以外のロールは、この DB に接続できない（public の connect を外してある）。"""
    admin.execute("create role probe_stranger login password 'stranger_pw'")
    try:
        url = pg.admin_url
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        d = {**conninfo_to_dict(url), "user": "probe_stranger", "password": "stranger_pw"}
        with pytest.raises(psycopg.OperationalError):
            psycopg.connect(make_conninfo(**d))
    finally:
        admin.execute("drop role probe_stranger")


# ---- 初期データ ----------------------------------------------------------------
def test_level_table_matches_mock_lv1_to_lv6(admin):
    rows = admin.execute("select level, required_points from level_table order by level").fetchall()
    assert rows[:6] == [(1, 50), (2, 60), (3, 80), (4, 110), (5, 140), (6, 190)]
    assert len(rows) == 40 and rows[7] == (8, 330)
    cum = 0
    seen = {}
    for lv, req in rows:
        assert req % 10 == 0
        cum += req
        seen[lv] = cum
    assert [seen[n] for n in (6, 10, 20, 28, 29, 40)] == [630, 2200, 33430, 274430, 356840, 6399600]


def test_seed_actions_and_bands(admin):
    defs = {r[0]: r[1:] for r in admin.execute("select id, frequency, detail from action_defs")}
    assert len(defs) == 9
    assert defs["weight"] == ("daily_once", "weight") and defs["water"] == ("repeatable", "none")
    assert defs["breakfast"] == ("daily_once", "meal") and defs["veggie"] == ("daily_once", "none")
    bands = {}
    for band, action_id in admin.execute("select band, action_id from action_bands order by band, position"):
        bands.setdefault(band, []).append(action_id)
    assert bands == {"morning": ["weight", "breakfast", "water"], "noon": ["lunch", "walk", "stairs"],
                     "night": ["dinner", "no_snack", "weight"]}
    assert all("veggie" not in ids for ids in bands.values())


def test_migration_is_idempotent(pg, admin):
    from tests.conftest import MIGRATIONS
    before = admin.execute("select count(*) from level_table").fetchone()[0]
    for f in MIGRATIONS:
        admin.execute(f.read_text())
    assert admin.execute("select count(*) from level_table").fetchone()[0] == before
    assert probe.run_probe(pg.admin_url) == []


# ---- 合計（行数の上限で切れない） ------------------------------------------------
def test_total_over_1000_rows(api, admin, now, new_sub):
    sub = new_sub()
    home(api, sub)
    uid = user_id(admin, sub)
    admin.execute(
        "insert into records(user_id, action_id, local_date) select %s, 'water', %s from generate_series(1, 1001)",
        (uid, TODAY))
    h = home(api, sub).json()["progress"]
    assert h["total_points"] == 10010
    # レベル表から期待値を計算して突き合わせる
    cum, expected_level, current = 0, None, None
    for lv, req in admin.execute("select level, required_points from level_table order by level"):
        if 10010 < cum + req:
            expected_level, current = lv, 10010 - cum
            break
        cum += req
    assert (h["level"], h["current_points"]) == (expected_level, current)


def test_max_level_caps_at_40(api, admin, now, new_sub):
    sub = new_sub()
    home(api, sub)
    uid = user_id(admin, sub)
    # Lv40 まで 6,399,600 点。10 点の行 640,000 行で 6,400,000 点（頭打ち）
    admin.execute(
        "insert into records(user_id, action_id, local_date) select %s, 'water', %s from generate_series(1, 640000)",
        (uid, TODAY))
    p = home(api, sub).json()["progress"]
    assert p["level"] == 40 and p["is_max"] is True and p["remaining_points"] == 0
    assert p["current_points"] == p["required_points"] == 1476890


def test_boundary_levels_exactly_50_and_110(api, admin, now, new_sub):
    sub = new_sub()
    home(api, sub)
    uid = user_id(admin, sub)
    for rows, expect in ((4, (1, 40)), (5, (2, 0)), (10, (2, 50)), (11, (3, 0))):
        admin.execute("delete from records where user_id = %s", (uid,))
        admin.execute("insert into records(user_id, action_id, local_date) "
                      "select %s, 'water', %s from generate_series(1, %s)", (uid, TODAY, rows))
        p = home(api, sub).json()["progress"]
        assert (p["level"], p["current_points"]) == expect


# ---- トリガ・制約（直接 SQL） ----------------------------------------------------
@pytest.fixture
def rec(admin, new_sub):
    """直接 SQL 用: 利用者と、水・体重の記録を 1 行ずつ作る。"""
    uid = admin.execute("select app_login(%s, 'a@b')", (new_sub(),)).fetchone()[0]
    water = admin.execute(
        "insert into records(user_id, action_id, local_date) values (%s, 'water', %s) returning id", (uid, TODAY)
    ).fetchone()[0]
    return type("R", (), {"uid": uid, "water": water})


def test_trigger_blocks_points_decrease(admin, rec):
    with pytest.raises(errors.CheckViolation):
        admin.execute("update records set press_points = 0 where id = %s", (rec.water,))


def test_trigger_blocks_immutable_columns(admin, rec):
    for col, val in (("local_date", date(2026, 10, 18)), ("action_id", "walk"), ("user_id", uuid4())):
        with pytest.raises(errors.CheckViolation):
            admin.execute(f"update records set {col} = %s where id = %s", (val, rec.water))


def test_trigger_slot_date_must_match_frequency(admin, rec):
    # daily_once なのに slot_date が NULL → 拒否
    with pytest.raises(errors.CheckViolation):
        admin.execute("insert into records(user_id, action_id, local_date) values (%s, 'dinner', %s)",
                      (rec.uid, TODAY))
    # repeatable なのに slot_date がある → 拒否
    with pytest.raises(errors.CheckViolation):
        admin.execute("insert into records(user_id, action_id, local_date, slot_date) values (%s, 'water', %s, %s)",
                      (rec.uid, TODAY, TODAY))
    # slot_date と local_date が違う → 拒否
    with pytest.raises(errors.CheckViolation):
        admin.execute("insert into records(user_id, action_id, local_date, slot_date) values (%s, 'dinner', %s, %s)",
                      (rec.uid, TODAY, date(2026, 10, 18)))


def test_trigger_detail_consistency(admin, rec):
    ok = admin.execute(
        "insert into records(user_id, action_id, local_date, slot_date, confirm_points, weight_kg) "
        "values (%s, 'weight', %s, %s, 20, 64.8) returning id", (rec.uid, TODAY, TODAY)).fetchone()[0]
    assert ok
    cases = [
        # detail=none（水）に確定の点・値は入れられない
        ("water", None, 20, None, None),
        ("water", None, 0, 60.0, None),
        # weight の行に量、meal の行に体重は入れられない
        ("weight", TODAY, 20, None, "small"),
        ("breakfast", TODAY, 20, 60.0, None),
    ]
    for act, slot, cp, w, p in cases:
        with pytest.raises((errors.CheckViolation,)):
            admin.execute(
                "insert into records(user_id, action_id, local_date, slot_date, confirm_points, weight_kg, portion) "
                "values (%s, %s, %s, %s, %s, %s, %s)", (rec.uid, act, TODAY, slot, cp, w, p))


def test_check_value_requires_confirm_points(admin, rec):
    """値があるなら confirm_points > 0（値あり・0 点の中途半端な状態を作れない）。"""
    with pytest.raises(errors.CheckViolation):
        admin.execute("insert into records(user_id, action_id, local_date, slot_date, weight_kg) "
                      "values (%s, 'weight', %s, %s, 64.8)", (rec.uid, TODAY, TODAY))


def test_check_point_values_and_weight_range(admin, rec):
    with pytest.raises(errors.CheckViolation):
        admin.execute("insert into records(user_id, action_id, local_date, press_points) values (%s,'water',%s,5)",
                      (rec.uid, TODAY))
    with pytest.raises(errors.CheckViolation):
        admin.execute("insert into records(user_id, action_id, local_date, slot_date, confirm_points, weight_kg) "
                      "values (%s,'weight',%s,%s,20,300.1)", (rec.uid, TODAY, TODAY))


def test_unique_daily_once_slot(admin, rec):
    admin.execute("insert into records(user_id, action_id, local_date, slot_date) values (%s,'dinner',%s,%s)",
                  (rec.uid, TODAY, TODAY))
    with pytest.raises(errors.UniqueViolation):
        admin.execute("insert into records(user_id, action_id, local_date, slot_date) values (%s,'dinner',%s,%s)",
                      (rec.uid, TODAY, TODAY))


def test_action_defs_guard(admin, rec):
    with pytest.raises(errors.CheckViolation):
        admin.execute("delete from action_defs where id = 'veggie'")
    # 記録がある行為（水）の frequency / detail は変えられない。記録のない行為（階段）は変えられる
    with pytest.raises(errors.CheckViolation):
        admin.execute("update action_defs set frequency = 'daily_once' where id = 'water'")
    admin.execute("update action_defs set label = '水を飲んだ' where id = 'water'")          # 同じ値・名前の更新は通る
    admin.execute("update action_defs set is_active = false where id = 'stairs'")
    admin.execute("update action_defs set is_active = true where id = 'stairs'")


def test_level_table_guard(admin):
    with pytest.raises(errors.CheckViolation):
        admin.execute("update level_table set required_points = 60 where level = 1")     # 上げる更新は拒否
    with pytest.raises(errors.CheckViolation):
        admin.execute("delete from level_table where level = 40")
    admin.execute("update level_table set required_points = 50 where level = 1")         # 同じ値は通る
    admin.execute("update level_table set required_points = 40 where level = 1")         # 下げる更新は通る
    # 後始末のため元に戻す（上げる更新はトリガが断つので、トリガを一時的に外す＝メンテ手順）
    admin.execute("alter table level_table disable trigger level_table_guard")
    admin.execute("update level_table set required_points = 50 where level = 1")
    admin.execute("alter table level_table enable trigger level_table_guard")


def test_inactive_action_rejected(api, admin, now, new_sub):
    admin.execute("update action_defs set is_active = false where id = 'stairs'")
    try:
        r = press(api, new_sub(), "stairs")
        assert r.status_code == 409 and r.json()["error"] == "action_inactive"
        sub = new_sub()
        ids = [a["id"] for a in home(api, sub).json()["major"] + home(api, sub).json()["minor"]]
        assert "stairs" not in ids
    finally:
        admin.execute("update action_defs set is_active = true where id = 'stairs'")


def test_unknown_action_404(api, now, new_sub):
    r = press(api, new_sub(), "nope")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


# ---- 並行 -------------------------------------------------------------------
def test_concurrent_press_single_row(repo_of, admin, new_sub):
    """別の操作 ID で、同じ日の 1 日 1 回を同時に送っても 1 行だけ。点は 1 回分。"""
    sub = new_sub()
    repo = repo_of(sub)
    results, errs = [], []

    def worker():
        try:
            results.append(repo.press(uuid4(), "dinner", TODAY))
        except Exception as e:  # noqa: BLE001
            errs.append(e)

    ts = [threading.Thread(target=worker) for _ in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs
    assert sorted(r["reason"] for r in results) == ["already_recorded"] * 7 + ["granted"]
    assert admin.execute("select count(*) from records r join users u on u.id = r.user_id where u.google_sub = %s",
                         (sub,)).fetchone()[0] == 1
    assert repo.total()["total_points"] == 10


def test_concurrent_press_single_levelup(repo_of, new_sub):
    """累計 40 点から 6 件を同時に押しても、弾け（レベルが上がる）のは 1 件だけ。"""
    repo = repo_of(new_sub())
    for _ in range(4):
        repo.press(uuid4(), "water", TODAY)
    results = []

    def worker():
        results.append(repo.press(uuid4(), "water", TODAY))

    ts = [threading.Thread(target=worker) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    ups = [r for r in results if r["level_after"] > r["level_before"]]
    assert len(ups) == 1 and repo.total()["total_points"] == 100


def test_concurrent_daily_cap_not_exceeded(repo_of, admin, small_cap, new_sub):
    sub = new_sub()
    repo = repo_of(sub)
    outcome = []

    def worker():
        try:
            repo.press(uuid4(), "water", TODAY)
            outcome.append("ok")
        except ApiError as e:
            outcome.append(e.code)

    ts = [threading.Thread(target=worker) for _ in range(9)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert outcome.count("ok") == 3 and outcome.count("daily_cap") == 6


def test_data_access_requires_user_id(pg):
    """データアクセスのクラスは user_id（と接続）を持たずには作れない。リクエストの値で user_id を変えるメソッドも無い。"""
    with pytest.raises(TypeError):
        Repo()  # type: ignore[call-arg]
    for name in ("press", "confirm", "cancel", "home", "trend", "total"):
        import inspect
        assert "user_id" not in inspect.signature(getattr(Repo, name)).parameters


def test_deleted_user_returns_unauthorized(api, admin, now, new_sub):
    """統括が DB で利用者を削除した後、キャッシュに残った ID で来ても 500 にならず 401。次は新しい利用者になる。"""
    sub = new_sub()
    assert press(api, sub, "water").status_code == 200
    admin.execute("delete from users where google_sub = %s", (sub,))
    r = press(api, sub, "water")
    assert r.status_code == 401 and r.json()["error"] == "unauthorized"
    h = home(api, sub).json()          # 再登録（0 点・Lv1）
    assert h["progress"]["total_points"] == 0
