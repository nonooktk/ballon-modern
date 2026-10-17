"""エラー形式 {"error": コード, "message": 利用者に見せてよい文} と例外。DB のエラー文はそのまま返さない。"""
from __future__ import annotations

# コード → (HTTP ステータス, 利用者向けの文)
ERRORS: dict[str, tuple[int, str]] = {
    "bad_request": (400, "入力が正しくありません。"),
    "bad_detail": (400, "この行為では、その項目は送れません。"),
    "invalid_offset": (400, "端末の時差が正しくありません。"),
    "unauthorized": (401, "ログインが必要です。"),
    "token_expired": (401, "ログインの期限が切れました。もう一度ログインしてください。"),
    "not_found": (404, "見つかりませんでした。"),
    "action_inactive": (409, "この行為は今は使えません。"),
    "op_conflict": (409, "同じ操作 ID で別の操作は送れません。"),
    "record_cancelled": (409, "取り消し済みの記録です。"),
    "cancel_expired": (409, "取り消せる時間を過ぎました。"),
    "confirm_expired": (409, "確定できる期間を過ぎました。"),
    "rate_limited": (429, "操作が多すぎます。少し待ってからもう一度どうぞ。"),
    "daily_cap": (429, "今日はこれ以上記録できません。"),
    "service_unavailable": (503, "いま混み合っています。少し待ってからもう一度どうぞ。"),
    "internal_error": (500, "うまく処理できませんでした。"),
}


class ApiError(Exception):
    def __init__(self, code: str, *, retry_after: int | None = None) -> None:
        status, message = ERRORS[code]
        super().__init__(code)
        self.code = code
        self.status = status
        self.message = message
        self.retry_after = retry_after


class AuthFailure(Exception):
    """ID トークンの検証に失敗した。expired=True は期限切れ（頻度制限に数えない）。"""

    def __init__(self, *, expired: bool = False) -> None:
        super().__init__("expired" if expired else "invalid")
        self.expired = expired
