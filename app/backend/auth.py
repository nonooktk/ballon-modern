"""Google の ID トークンの検証（ARCHITECTURE §6.2）。

- 署名方式は RS256 に固定（alg=none・共有秘密方式は受け付けない）。
- iss は 2 表記、aud は自分のクライアント ID、exp・nbf・iat は 30 秒の許容、email_verified は真、sub は必須。
- 鍵の一覧（JWKS）は応答の有効期限の範囲でキャッシュ。未知の kid のときだけ再取得し、再取得は 60 秒に 1 回まで。
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import jwt

from errors import ApiError, AuthFailure

logger = logging.getLogger("ballon")

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
LEEWAY_SECONDS = 30
KID_REFETCH_INTERVAL = 60.0
_DEV_SUB_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

# fetch は (JWKS の dict, 有効期限の秒数) を返す
Fetch = Callable[[], tuple[dict[str, Any], int]]


def fetch_google_jwks() -> tuple[dict[str, Any], int]:
    with urllib.request.urlopen(GOOGLE_JWKS_URL, timeout=5) as res:
        body = json.loads(res.read())
        cc = res.headers.get("Cache-Control", "")
    m = re.search(r"max-age=(\d+)", cc)
    max_age = int(m.group(1)) if m else 3600
    return body, min(max(max_age, 60), 86400)


class GoogleKeys:
    def __init__(self, fetch: Fetch = fetch_google_jwks, clock: Callable[[], float] = time.monotonic) -> None:
        self._fetch = fetch
        self._clock = clock
        self._lock = threading.Lock()
        self._keys: dict[str, Any] = {}
        self._expires = 0.0
        self._last_fetch = float("-inf")

    def _refresh(self, now: float) -> None:
        try:
            body, max_age = self._fetch()
            keys: dict[str, Any] = {}
            for jwk in body.get("keys", []):
                if jwk.get("kty") == "RSA" and jwk.get("kid"):
                    keys[jwk["kid"]] = jwt.PyJWK.from_dict(jwk).key
        except (OSError, ValueError, KeyError, TypeError, jwt.PyJWTError):  # 取得失敗。古い鍵が残っていればそれで続ける
            logger.warning("Google の公開鍵の取得に失敗しました")
            self._last_fetch = now  # 失敗しても 60 秒は再取得しない
            if not self._keys:
                raise ApiError("service_unavailable") from None
            self._expires = now + 60
            return
        self._keys = keys
        self._expires = now + max_age
        self._last_fetch = now

    def get(self, kid: str) -> Any | None:
        with self._lock:
            now = self._clock()
            if now >= self._expires:
                self._refresh(now)
            key = self._keys.get(kid)
            if key is None and now - self._last_fetch >= KID_REFETCH_INTERVAL:
                self._refresh(now)  # 鍵の入れ替え直後を拾う。60 秒に 1 回まで
                key = self._keys.get(kid)
            return key


@dataclass(frozen=True)
class Identity:
    sub: str
    email: str


def _is_true(v: Any) -> bool:
    return v is True or (isinstance(v, str) and v.lower() == "true")


def verify_google_token(token: str, keys: GoogleKeys, client_id: str) -> Identity:
    """検証に失敗したら AuthFailure（期限切れだけ expired=True）。"""
    if not client_id:
        # 設定漏れで全員を通さないよう、クライアント ID が無ければ全拒否
        raise AuthFailure()
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256":
            raise AuthFailure()
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise AuthFailure()
        key = keys.get(kid)
        if key is None:
            raise AuthFailure()
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=GOOGLE_ISSUERS,
            leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except jwt.ExpiredSignatureError:
        raise AuthFailure(expired=True) from None
    except jwt.PyJWTError:
        raise AuthFailure() from None
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise AuthFailure()
    if not _is_true(claims.get("email_verified")):
        raise AuthFailure()
    email = claims.get("email")
    if not isinstance(email, str) or not email:
        raise AuthFailure()
    return Identity(sub=sub, email=email)


def verify_dev_token(token: str) -> Identity:
    """DEV_AUTH_BYPASS=1 のときだけ使う `dev:<sub>`。"""
    if not token.startswith("dev:") or not _DEV_SUB_RE.match(token[4:]):
        raise AuthFailure()
    sub = token[4:]
    return Identity(sub=f"dev:{sub}", email=f"{sub}@dev.invalid")
