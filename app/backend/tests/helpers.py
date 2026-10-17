"""テスト用の小さな補助。"""
from __future__ import annotations

import uuid


def op() -> str:
    return str(uuid.uuid4())


def press(api, sub: str, action: str, op_id: str | None = None, **hkw):
    return api.client.post("/records", json={"op_id": op_id or op(), "action_id": action}, headers=api.h(sub, **hkw))


def confirm(api, sub: str, record_id: str, op_id: str | None = None, **body):
    return api.client.put(f"/records/{record_id}/confirm", json={"op_id": op_id or op(), **body}, headers=api.h(sub))


def cancel(api, sub: str, record_id: str, op_id: str | None = None):
    return api.client.post(f"/records/{record_id}/cancel", json={"op_id": op_id or op()}, headers=api.h(sub))


def home(api, sub: str, **hkw):
    return api.client.get("/home", headers=api.h(sub, **hkw))


def action(home_json: dict, action_id: str) -> dict:
    for a in home_json["major"] + home_json["minor"]:
        if a["id"] == action_id:
            return a
    raise KeyError(action_id)


def user_id(admin, sub: str):
    return admin.execute("select id from users where google_sub = %s", (sub,)).fetchone()[0]
