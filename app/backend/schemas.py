"""リクエスト・レスポンスの型。docs/openapi.yaml と一致させる（テストで突き合わせる）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ConfirmState = Literal["none", "open", "done", "regrant_blocked"]


class Error(BaseModel):
    error: str
    message: str


class Progress(BaseModel):
    level: int
    current_points: int
    required_points: int
    remaining_points: int
    total_points: int
    is_max: bool


class LevelUp(BaseModel):
    before: int
    after: int


class ActionState(BaseModel):
    id: str
    label: str
    icon: str
    frequency: Literal["daily_once", "repeatable"]
    detail: Literal["none", "weight", "meal"]
    done: bool
    count: int
    record_id: UUID | None
    confirm_state: ConfirmState


class Home(BaseModel):
    progress: Progress
    local_date: date
    band: Literal["morning", "noon", "night"]
    major: list[ActionState]
    minor: list[ActionState]
    next_action_id: str | None
    last_weight_kg: float | None


class PressRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op_id: UUID
    action_id: str = Field(min_length=1, max_length=64)


class PressResult(BaseModel):
    record_id: UUID
    reason: Literal["granted", "revived", "already_recorded", "replayed"]
    granted_points: int
    confirm_state: ConfirmState
    progress: Progress
    level_up: LevelUp | None


class ConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op_id: UUID
    weight_kg: Decimal | None = Field(default=None, allow_inf_nan=False)
    portion: Literal["small", "normal", "large"] | None = None

    @field_validator("weight_kg")
    @classmethod
    def _weight(cls, v: Decimal | None) -> Decimal | None:
        # 小数 1 桁・20.0〜300.0 だけ。numeric(4,1) の黙った丸めに頼らない
        if v is None:
            return v
        if not v.is_finite() or not Decimal("20.0") <= v <= Decimal("300.0"):
            raise ValueError("weight_kg の範囲外")
        if v != v.quantize(Decimal("0.1")):
            raise ValueError("weight_kg は小数 1 桁まで")
        return v

    @model_validator(mode="after")
    def _exactly_one(self) -> ConfirmRequest:
        if (self.weight_kg is None) == (self.portion is None):
            raise ValueError("weight_kg か portion のどちらか一方だけを送る")
        return self


class ConfirmResult(BaseModel):
    record_id: UUID
    granted_points: int
    confirm_state: ConfirmState
    progress: Progress
    level_up: LevelUp | None


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op_id: UUID


class CancelResult(BaseModel):
    record_id: UUID
    cancelled: Literal[True]
    progress: Progress


class ResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op_id: UUID


class ResetResult(Progress):
    deleted: int


class TrendDay(BaseModel):
    date: date
    avg_kg: float | None


class Trend(BaseModel):
    days: list[TrendDay]
    current_avg_kg: float | None
    four_weeks_ago_avg_kg: float | None
    diff_kg: float | None
