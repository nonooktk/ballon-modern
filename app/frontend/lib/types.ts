// API の型。正本は docs/openapi.yaml（ツボツボが所有）。ここは画面側の写しで、手で足したり変えたりしない。

export type ConfirmState = "none" | "open" | "done" | "regrant_blocked";
export type Band = "morning" | "noon" | "night";
export type Portion = "small" | "normal" | "large";

export interface Progress {
  level: number;
  current_points: number;
  required_points: number;
  remaining_points: number;
  total_points: number;
  is_max: boolean;
}

export interface LevelUp {
  before: number;
  after: number;
}

export interface ActionState {
  id: string;
  label: string;
  icon: string;
  frequency: "daily_once" | "repeatable";
  detail: "none" | "weight" | "meal";
  done: boolean;
  count: number;
  record_id: string | null;
  confirm_state: ConfirmState;
}

export interface Home {
  progress: Progress;
  local_date: string;
  band: Band;
  major: ActionState[];
  minor: ActionState[];
  next_action_id: string | null;
  last_weight_kg: number | null;
}

export type PressReason = "granted" | "revived" | "already_recorded" | "replayed";

export interface PressResult {
  record_id: string;
  reason: PressReason;
  granted_points: number;
  confirm_state: ConfirmState;
  progress: Progress;
  level_up: LevelUp | null;
}

export interface ConfirmDetail {
  weight_kg?: number;
  portion?: Portion;
}

export interface ConfirmResult {
  record_id: string;
  granted_points: number;
  confirm_state: ConfirmState;
  progress: Progress;
  level_up: LevelUp | null;
}

export interface CancelResult {
  record_id: string;
  cancelled: true;
  progress: Progress;
}

export interface TrendDay {
  date: string;
  avg_kg: number | null;
}

export interface Trend {
  days: TrendDay[];
  current_avg_kg: number | null;
  four_weeks_ago_avg_kg: number | null;
  diff_kg: number | null;
}

export type ErrorCode =
  | "bad_request" | "bad_detail" | "invalid_offset" | "unauthorized" | "token_expired"
  | "not_found" | "action_inactive" | "op_conflict" | "record_cancelled" | "cancel_expired"
  | "confirm_expired" | "rate_limited" | "daily_cap" | "service_unavailable"
  // 画面側で足す（API は返さない）
  | "network" | "unknown";
