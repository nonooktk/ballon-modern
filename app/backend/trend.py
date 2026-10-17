"""体重の 7 日平均（ARCHITECTURE §5）。DB は日ごとの体重（34 日ぶん）を返し、平均はここで計算する。"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

DAYS = 28      # 折れ線の日数
WINDOW = 7     # 平均に使う日数


def _round1(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


def build_trend(points: list[dict[str, Any]], today: date) -> dict[str, Any]:
    """points: [{"date": "YYYY-MM-DD", "kg": 数値}, ...]（取り消されていない体重・日ごとの平均）。
    各日 D の値は D-6〜D の 7 日のうち、値のある日だけの平均（小数 1 桁・四捨五入。1 日も無ければ null）。
    4 週前との差は、折れ線の左端（27 日前）の平均と今日の平均の差（どちらかが無ければ null）。"""
    by_date = {date.fromisoformat(p["date"]): Decimal(str(p["kg"])) for p in points}

    def avg_at(d: date) -> Decimal | None:
        vals = [by_date[d - timedelta(days=i)] for i in range(WINDOW) if (d - timedelta(days=i)) in by_date]
        if not vals:
            return None
        return _round1(sum(vals) / len(vals))

    days = []
    for offset in range(DAYS - 1, -1, -1):
        d = today - timedelta(days=offset)
        a = avg_at(d)
        days.append({"date": d, "avg_kg": float(a) if a is not None else None})
    current = avg_at(today)
    oldest = avg_at(today - timedelta(days=DAYS - 1))
    diff = _round1(current - oldest) if current is not None and oldest is not None else None
    return {
        "days": days,
        "current_avg_kg": float(current) if current is not None else None,
        "four_weeks_ago_avg_kg": float(oldest) if oldest is not None else None,
        "diff_kg": float(diff) if diff is not None else None,
    }
