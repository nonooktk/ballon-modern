"""DB へのアクセス。書き込みも読み取りも、ロール ballon_api が呼べる関数 7 本だけを使う。
Repo は user_id を持って生まれる。すべての呼び出しにその user_id を渡し、リクエストの値は使わない。"""
from __future__ import annotations

import time
from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from psycopg_pool import ConnectionPool

from errors import ApiError


def make_pool(database_url: str, max_size: int) -> ConnectionPool:
    # 起動時にプールを 1 つ作って使い回す。接続数は DB サーバーの上限を考えて小さく（U11）
    # check: 借りるときに接続が生きているか確かめる（Azure の中継が、使われていない接続を切ることがあるため）
    return ConnectionPool(
        database_url, min_size=1, max_size=max_size, timeout=10, open=True, check=ConnectionPool.check_connection
    )


def _check(result: dict[str, Any]) -> dict[str, Any]:
    """関数が返す {"status": "error", "error": コード} を ApiError に直す。"""
    if result.get("status") == "error":
        raise ApiError(result["error"])
    return result


def login(pool: ConnectionPool, sub: str, email: str) -> UUID:
    with pool.connection() as conn:
        row = conn.execute("select app_login(%s::text, %s::text)", (sub, email)).fetchone()
    return row[0]


class Repo:
    def __init__(self, pool: ConnectionPool, user_id: UUID) -> None:
        self._pool = pool
        self._user_id = user_id

    def _call(self, sql: str, params: tuple[Any, ...]) -> dict[str, Any]:
        with self._pool.connection() as conn:
            row = conn.execute(sql, (self._user_id, *params)).fetchone()
        return _check(row[0])

    def press(self, op_id: UUID, action_id: str, local_date: date) -> dict[str, Any]:
        return self._call(
            "select app_press(%s::uuid, %s::uuid, %s::text, %s::date)", (op_id, action_id, local_date)
        )

    def confirm(
        self, op_id: UUID, record_id: UUID, weight: Decimal | None, portion: str | None, local_date: date
    ) -> dict[str, Any]:
        return self._call(
            "select app_confirm(%s::uuid, %s::uuid, %s::uuid, %s::numeric, %s::text, %s::date)",
            (op_id, record_id, weight, portion, local_date),
        )

    def cancel(self, op_id: UUID, record_id: UUID) -> dict[str, Any]:
        return self._call("select app_cancel(%s::uuid, %s::uuid, %s::uuid)", (op_id, record_id))

    def total(self) -> dict[str, Any]:
        with self._pool.connection() as conn:
            row = conn.execute("select app_total(%s::uuid)", (self._user_id,)).fetchone()
        return row[0]

    def home(self, local_date: date) -> dict[str, Any]:
        return self._call("select app_home_state(%s::uuid, %s::date)", (local_date,))

    def trend(self, local_date: date) -> dict[str, Any]:
        return self._call("select app_trend(%s::uuid, %s::date)", (local_date,))


class UserCache:
    """sub → 内部の user_id を 1 時間までメモリに持つ。削除済みの利用者で unauthorized が返ったら捨てる。"""

    def __init__(self, ttl: float = 3600.0) -> None:
        self._ttl = ttl
        self._data: dict[str, tuple[UUID, float]] = {}

    def get(self, sub: str) -> UUID | None:
        hit = self._data.get(sub)
        if hit and hit[1] > time.monotonic():
            return hit[0]
        self._data.pop(sub, None)
        return None

    def put(self, sub: str, user_id: UUID) -> None:
        if len(self._data) > 50000:
            self._data.clear()
        self._data[sub] = (user_id, time.monotonic() + self._ttl)

    def drop(self, sub: str) -> None:
        self._data.pop(sub, None)
