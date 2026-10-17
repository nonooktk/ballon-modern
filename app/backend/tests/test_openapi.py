"""docs/openapi.yaml（画面との境界の正本）と、実装の /openapi.json が一致していること。"""
from __future__ import annotations

from pathlib import Path

import yaml

from errors import ERRORS
from main import create_app

DOC = Path(__file__).resolve().parents[3] / "docs" / "openapi.yaml"
HTTP = {"get", "post", "put", "patch", "delete"}


def _load():
    spec = yaml.safe_load(DOC.read_text())
    gen = create_app().openapi()
    return spec, gen


def _ops(spec):
    return {(m.upper(), p, o["operationId"]) for p, item in spec["paths"].items() for m, o in item.items() if m in HTTP}


def test_paths_methods_and_operation_ids_match():
    spec, gen = _load()
    assert _ops(spec) == _ops(gen)


def test_no_delete_endpoint():
    spec, gen = _load()
    assert not any(m == "DELETE" for m, _, _ in _ops(spec) | _ops(gen))


def test_schema_properties_and_required_match():
    spec, gen = _load()
    ys, gs = spec["components"]["schemas"], gen["components"]["schemas"]
    checked = 0
    for name, ydef in ys.items():
        if name not in gs or "properties" not in ydef:
            continue
        gdef = gs[name]
        assert set(ydef["properties"]) == set(gdef["properties"]), name
        assert set(ydef.get("required", [])) == set(gdef.get("required", [])), name
        checked += 1
    assert checked >= 12          # Error・Progress・LevelUp・ActionState・Home・各 Request/Result・Trend など


def test_error_codes_match_implementation():
    spec, _ = _load()
    assert set(spec["components"]["schemas"]["Error"]["properties"]["error"]["enum"]) == set(ERRORS)


def test_tz_offset_header_declared_on_authenticated_endpoints():
    spec, gen = _load()
    for p, item in gen["paths"].items():
        for m, o in item.items():
            if m not in HTTP or p == "/health":
                continue
            names = {x["name"].lower() for x in o.get("parameters", [])}
            assert "x-client-tz-offset" in names, (m, p)
            assert "x-client-tz-offset" in {
                (x["name"] if "name" in x else spec["components"]["parameters"][x["$ref"].split("/")[-1]]["name"]).lower()
                for x in spec["paths"][p][m]["parameters"]
            }


def test_request_bodies_have_no_user_id():
    """利用者はトークンの sub から決める。リクエストに user_id を受け取る項目は無い。"""
    spec, gen = _load()
    for s in (spec, gen):
        for name in ("PressRequest", "ConfirmRequest", "CancelRequest", "ResetRequest"):
            assert "user_id" not in s["components"]["schemas"][name]["properties"]
