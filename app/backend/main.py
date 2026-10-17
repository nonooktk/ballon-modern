"""ふうせん API（骨組み）。

起動: uvicorn main:app --reload --port 8000
確認: http://localhost:8000/docs

中身（認証・DB 接続・各エンドポイント）は T1〜T3 で実装する。
"""
import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()  # 同じフォルダの .env を読む（Azure ではアプリ設定から読むので .env は不要）

app = FastAPI(title="ballon-modern API", version="0.1.0")

# CORS: 画面の URL と localhost だけ許す。ALLOWED_ORIGINS はカンマ区切り。
allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Authorization", "Content-Type", "X-Client-Tz-Offset"],
    expose_headers=["Retry-After"],
)


@app.get("/health")
def health():
    """API が生きているかの確認用。DB には触らない。"""
    return {"status": "ok"}
