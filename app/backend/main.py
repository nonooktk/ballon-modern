"""ふうせん API。

起動: uvicorn main:app --reload --port 8000
確認: http://localhost:8000/docs

構成: 画面 → この API（ID トークンの検証・時差の検証・頻度制限・今日の一手と 7 日平均）→ DB の関数 7 本。
DB には ballon_api ロール（関数の実行だけができる）で接続する。
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Any
from uuid import UUID

import psycopg
import psycopg_pool
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException

import db
import tzdate
from auth import GoogleKeys, Identity, verify_dev_token, verify_google_token
from config import Settings, load_settings
from errors import ApiError, AuthFailure
from ratelimit import RateLimiter
from schemas import (
    CancelRequest,
    CancelResult,
    ConfirmRequest,
    ConfirmResult,
    Error,
    Home,
    PressRequest,
    PressResult,
    ResetRequest,
    ResetResult,
    Trend,
)
from trend import build_trend

load_dotenv()  # 同じフォルダの .env を読む（Azure ではアプリ設定から読むので .env は不要）
logger = logging.getLogger("ballon")


class Services:
    """アプリ全体で使い回すもの。テストでは鍵・プール・設定を差し替えて作る。"""

    def __init__(
        self,
        settings: Settings,
        keys: GoogleKeys | None = None,
        limiter: RateLimiter | None = None,
        pool: psycopg_pool.ConnectionPool | None = None,
    ) -> None:
        self.settings = settings
        self.keys = keys or GoogleKeys()
        self.limiter = limiter or RateLimiter()
        self.users = db.UserCache()
        self._pool = pool

    @property
    def pool(self) -> psycopg_pool.ConnectionPool:
        if self._pool is None:
            if not self.settings.database_url:
                raise ApiError("service_unavailable")
            self._pool = db.make_pool(self.settings.database_url, self.settings.pool_max)
        return self._pool

    def close(self) -> None:
        if self._pool is not None:
            self._pool.close()

    def identify(self, token: str) -> Identity:
        if self.settings.dev_auth_bypass and token.startswith("dev:"):
            return verify_dev_token(token)
        return verify_google_token(token, self.keys, self.settings.google_client_id)


def client_ip(request: Request) -> str:
    """X-Forwarded-For の最後尾（Azure のフロントエンドが付ける値。先頭は端末が書けるので使わない）。
    IPv4:ポート や [IPv6]:ポート の形式ならポートを取り除く。"""
    xff = request.headers.get("x-forwarded-for", "")
    last = xff.split(",")[-1].strip() if xff else ""
    if not last:
        return request.client.host if request.client else "unknown"
    if last.startswith("["):
        return last[1 : last.index("]")] if "]" in last else last
    if last.count(":") == 1:  # IPv4:ポート
        return last.split(":")[0]
    return last


_bearer = HTTPBearer(auto_error=False)


@dataclass
class Ctx:
    """認証と時差の検証を通ったリクエストの文脈。user_id は検証済みの sub から決めた値だけ。"""

    svc: Services
    sub: str
    repo: db.Repo
    local_date: date
    band: str

    def run(self, fn, *args: Any) -> dict[str, Any]:
        try:
            return fn(*args)
        except ApiError as e:
            if e.code == "unauthorized":
                self.svc.users.drop(self.sub)  # 削除済みの利用者。キャッシュを捨てて 401
            raise


def get_ctx(
    request: Request,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    x_client_tz_offset: Annotated[str | None, Header(description="端末の時差（分）。-720〜840 の整数")] = None,
) -> Ctx:
    svc: Services = request.app.state.svc
    s = svc.settings
    try:
        if creds is None:
            raise AuthFailure()
        ident = svc.identify(creds.credentials)
    except AuthFailure as f:
        if f.expired:
            # 期限切れは頻度制限に数えない（講義の開始 1 時間後にいっせいに切れても止まらないため）
            raise ApiError("token_expired") from None
        retry = svc.limiter.hit(f"af:{client_ip(request)}", [(60, s.auth_fail_per_min)])
        if retry:
            raise ApiError("rate_limited", retry_after=retry) from None
        raise ApiError("unauthorized") from None

    # 認証に成功したリクエストには IP 制限を掛けず、利用者（sub）ごとに数える
    if request.method in ("POST", "PUT"):
        rules, kind = [(1, s.write_per_sec), (60, s.write_per_min)], "w"
    else:
        rules, kind = [(60, s.read_per_min)], "r"
    retry = svc.limiter.hit(f"{kind}:{ident.sub}", rules)
    if retry:
        raise ApiError("rate_limited", retry_after=retry)

    offset = tzdate.parse_offset(x_client_tz_offset)
    local_date, band = tzdate.local_date_and_band(offset)

    user_id = svc.users.get(ident.sub)
    if user_id is None:
        user_id = db.login(svc.pool, ident.sub, ident.email)  # 初回は登録（0 点・Lv1）
        svc.users.put(ident.sub, user_id)
    return Ctx(svc=svc, sub=ident.sub, repo=db.Repo(svc.pool, user_id), local_date=local_date, band=band)


CtxDep = Annotated[Ctx, Depends(get_ctx)]
_ERR = {c: {"model": Error} for c in (400, 401, 404, 409, 429)}


def _level_up(res: dict[str, Any]) -> dict[str, int] | None:
    """レベルが上がったときだけ前後を返す。再送（replayed）では出さない。"""
    if res.get("reason") == "replayed" or res["level_after"] <= res["level_before"]:
        return None
    return {"before": res["level_before"], "after": res["level_after"]}


def _action_state(a: dict[str, Any]) -> dict[str, Any]:
    return {**a, "done": a["count"] > 0}


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    svc = services or Services(settings or load_settings())

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        svc.close()

    # 本番では /docs・/redoc・/openapi.json を出さない（監査 F-8）
    docs = not svc.settings.is_production
    app = FastAPI(
        title="ballon-modern API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )
    app.state.svc = svc

    # セキュリティヘッダ（監査 F-1）。API は JSON だけを返すので CSP は全部拒否でよい
    @app.middleware("http")
    async def _security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        if "server" in resp.headers:
            del resp.headers["server"]
        return resp

    # CORS: 画面の URL と localhost だけ。使うメソッド・ヘッダーに絞る
    app.add_middleware(
        CORSMiddleware,
        allow_origins=svc.settings.allowed_origins,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Authorization", "Content-Type", "X-Client-Tz-Offset"],
        expose_headers=["Retry-After"],
    )

    def _error_response(e: ApiError) -> JSONResponse:
        if e.code in ("rate_limited", "daily_cap"):
            logger.info("error=%s", e.code)  # 数値の見直しに使う件数（個人情報は出さない）
        headers = {"Retry-After": str(e.retry_after)} if e.retry_after else None
        return JSONResponse({"error": e.code, "message": e.message}, status_code=e.status, headers=headers)

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, e: ApiError):
        return _error_response(e)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, __: RequestValidationError):
        return _error_response(ApiError("bad_request"))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException):
        code = "not_found" if e.status_code == 404 else "bad_request"
        resp = _error_response(ApiError(code))
        resp.status_code = e.status_code
        return resp

    @app.exception_handler(psycopg.OperationalError)
    @app.exception_handler(psycopg_pool.PoolTimeout)
    @app.exception_handler(psycopg_pool.PoolClosed)
    async def _db_down(_: Request, __: Exception):
        logger.error("DB に接続できません")
        return _error_response(ApiError("service_unavailable"))

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, e: Exception):
        logger.error("想定外のエラー: %s", type(e).__name__)  # 本文・SQL・トークンは出さない
        return _error_response(ApiError("internal_error"))

    @app.get("/health", operation_id="health")
    def health() -> dict[str, str]:
        """API が生きているかの確認用。認証不要・DB には触らない・頻度制限に数えない。"""
        return {"status": "ok"}

    @app.get("/home", response_model=Home, responses=_ERR, operation_id="getHome")
    def get_home(ctx: CtxDep):
        st = ctx.run(ctx.repo.home, ctx.local_date)
        actions = {a["id"]: a for a in st["actions"]}
        major_ids = [i for i in st["bands"][ctx.band] if i in actions]
        major = [_action_state(actions[i]) for i in major_ids]
        minor = [_action_state(a) for a in st["actions"] if a["id"] not in major_ids]
        # 今日の一手: 時間帯の大 3 つの並びの最初の、今日の有効な記録がない行為（決定的）
        next_id = next((i for i in major_ids if actions[i]["count"] == 0), None)
        return {
            "progress": st["progress"],
            "local_date": ctx.local_date,
            "band": ctx.band,
            "major": major,
            "minor": minor,
            "next_action_id": next_id,
            "last_weight_kg": st["last_weight_kg"],
        }

    @app.post("/records", response_model=PressResult, responses=_ERR, operation_id="pressAction")
    def press(body: PressRequest, ctx: CtxDep):
        res = ctx.run(ctx.repo.press, body.op_id, body.action_id, ctx.local_date)
        return {**res, "level_up": _level_up(res)}

    @app.put(
        "/records/{record_id}/confirm", response_model=ConfirmResult, responses=_ERR, operation_id="confirmRecord"
    )
    def confirm(record_id: UUID, body: ConfirmRequest, ctx: CtxDep):
        res = ctx.run(ctx.repo.confirm, body.op_id, record_id, body.weight_kg, body.portion, ctx.local_date)
        return {**res, "level_up": _level_up(res)}

    @app.post(
        "/records/{record_id}/cancel", response_model=CancelResult, responses=_ERR, operation_id="cancelRecord"
    )
    def cancel(record_id: UUID, body: CancelRequest, ctx: CtxDep):
        return ctx.run(ctx.repo.cancel, body.op_id, record_id)

    @app.post("/me/reset", response_model=ResetResult, responses=_ERR, operation_id="resetMe")
    def reset_me(body: ResetRequest, ctx: CtxDep):
        """デモ用: 自分の記録・点・レベルをすべて消して Lv1・0 点に戻す（本人の明示操作だけ）。"""
        res = ctx.run(ctx.repo.reset, body.op_id)
        return {**res["progress"], "deleted": res["deleted"]}

    @app.get("/trend", response_model=Trend, responses=_ERR, operation_id="getTrend")
    def get_trend(ctx: CtxDep):
        res = ctx.run(ctx.repo.trend, ctx.local_date)
        return build_trend(res["points"], ctx.local_date)

    return app


app = create_app()
