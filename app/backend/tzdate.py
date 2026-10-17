"""日付と時間帯。端末の時計は使わず、サーバー時刻に端末の時差（分）を足して出す（ARCHITECTURE §7）。"""
from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta

from errors import ApiError

_OFFSET_RE = re.compile(r"^-?[0-9]{1,4}$")
OFFSET_MIN, OFFSET_MAX = -720, 840


def utcnow() -> datetime:
    """サーバーの現在時刻（UTC）。テストでは差し替える。"""
    return datetime.now(UTC)


def parse_offset(raw: str | None) -> int:
    """X-Client-Tz-Offset を検証して分の整数にする。無い・整数でない・範囲外は 400 invalid_offset。"""
    if raw is None or not _OFFSET_RE.match(raw.strip()):
        raise ApiError("invalid_offset")
    value = int(raw.strip())
    if not OFFSET_MIN <= value <= OFFSET_MAX:
        raise ApiError("invalid_offset")
    return value


def local_datetime(offset_min: int, now: datetime | None = None) -> datetime:
    base = now or utcnow()
    return (base + timedelta(minutes=offset_min)).replace(tzinfo=None)


def band_of(local_dt: datetime) -> str:
    """朝 4:00〜9:59、昼 10:00〜15:59、夜 16:00〜翌 3:59。"""
    h = local_dt.hour
    if 4 <= h < 10:
        return "morning"
    if 10 <= h < 16:
        return "noon"
    return "night"


def local_date_and_band(offset_min: int, now: datetime | None = None) -> tuple[date, str]:
    ldt = local_datetime(offset_min, now)
    return ldt.date(), band_of(ldt)
