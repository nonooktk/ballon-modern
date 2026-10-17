"""環境変数から読む設定。秘匿値（DATABASE_URL など）はログに出さない。"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger("ballon")


def _int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    database_url: str = ""
    google_client_id: str = ""
    allowed_origins: list[str] = field(default_factory=lambda: ["http://localhost:3000"])
    app_env: str = "development"
    dev_auth_bypass: bool = False
    pool_max: int = 5
    # レート制限（ARCHITECTURE §8。暫定値・緩い側から）
    write_per_sec: int = 20
    write_per_min: int = 300
    read_per_min: int = 120
    auth_fail_per_min: int = 60

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


def load_settings() -> Settings:
    origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
    app_env = os.getenv("APP_ENV", "development").strip() or "development"
    wants_bypass = os.getenv("DEV_AUTH_BYPASS", "").strip() == "1"
    s = Settings(
        database_url=os.getenv("DATABASE_URL", ""),
        google_client_id=os.getenv("GOOGLE_CLIENT_ID", "").strip(),
        allowed_origins=origins,
        app_env=app_env,
        # 本番では環境変数があっても開発用の認証迂回を無効にする
        dev_auth_bypass=wants_bypass and app_env.lower() != "production",
        pool_max=_int("DB_POOL_MAX", 5),
        write_per_sec=_int("RATE_WRITE_PER_SEC", 20),
        write_per_min=_int("RATE_WRITE_PER_MIN", 300),
        read_per_min=_int("RATE_READ_PER_MIN", 120),
        auth_fail_per_min=_int("RATE_AUTH_FAIL_PER_MIN", 60),
    )
    if wants_bypass and s.is_production:
        logger.warning("APP_ENV=production のため DEV_AUTH_BYPASS は無視します（開発用の認証迂回は無効）")
    if s.dev_auth_bypass:
        logger.warning("DEV_AUTH_BYPASS=1: 開発用の認証迂回が有効です（本番では使わないこと）")
    return s
