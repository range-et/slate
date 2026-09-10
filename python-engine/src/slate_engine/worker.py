"""Newline-delimited JSON worker entry point."""

from __future__ import annotations

import json
import sys
from typing import Any, TextIO

from .parser import parse_module
from .patcher import (
    propose_adopt_unit,
    propose_insert_stub,
    propose_replace_unit,
    propose_update_annotation,
)
from .protocol import (
    PROTOCOL_VERSION,
    ProtocolError,
    parse_request,
    require_object,
    require_string,
)


def _dispatch(method: str, params: dict[str, Any]) -> tuple[Any, bool]:
    if method == "health":
        return {"status": "ok", "protocolVersion": PROTOCOL_VERSION}, False
    if method == "parseModule":
        source = require_string(params, "source")
        path = require_string(params, "path", "<memory>")
        unknown = set(params) - {"source", "path"}
        if unknown:
            raise ProtocolError(f"unknown parseModule params: {', '.join(sorted(unknown))}")
        return parse_module(source, path), False
    if method in {"adoptUnit", "updateAnnotation", "insertStub", "replaceUnit"}:
        source = require_string(params, "source")
        path = require_string(params, "path", "<memory>")
        expected_hash = require_string(params, "expectedHash")
        if method == "adoptUnit":
            _reject_unknown(params, {"source", "path", "expectedHash", "unitId", "annotation"}, method)
            return propose_adopt_unit(
                source,
                path,
                expected_hash,
                require_string(params, "unitId"),
                require_object(params, "annotation"),
            ), False
        if method == "updateAnnotation":
            _reject_unknown(params, {"source", "path", "expectedHash", "unitId", "annotation"}, method)
            return propose_update_annotation(
                source,
                path,
                expected_hash,
                require_string(params, "unitId"),
                require_object(params, "annotation"),
            ), False
        if method == "insertStub":
            _reject_unknown(params, {"source", "path", "expectedHash", "signature", "annotation", "parentId"}, method)
            parent_id = params.get("parentId")
            if parent_id is not None and not isinstance(parent_id, str):
                raise ProtocolError("params.parentId must be a string or null")
            return propose_insert_stub(
                source,
                path,
                expected_hash,
                require_string(params, "signature"),
                require_object(params, "annotation"),
                parent_id,
            ), False
        _reject_unknown(params, {"source", "path", "expectedHash", "unitId", "replacement"}, method)
        return propose_replace_unit(
            source,
            path,
            expected_hash,
            require_string(params, "unitId"),
            require_string(params, "replacement"),
        ), False
    if method == "shutdown":
        if params:
            raise ProtocolError("shutdown does not accept params")
        return {"status": "stopping"}, True
    raise ProtocolError(f"unknown method: {method}")


def _reject_unknown(params: dict[str, Any], allowed: set[str], method: str) -> None:
    unknown = set(params) - allowed
    if unknown:
        raise ProtocolError(f"unknown {method} params: {', '.join(sorted(unknown))}")


def serve(stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
    for raw_line in stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id: str | int | None = None
        stop = False
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                candidate_id = value.get("id")
                if isinstance(candidate_id, (str, int)) and not isinstance(candidate_id, bool):
                    request_id = candidate_id
            request = parse_request(value)
            request_id = request.request_id
            result, stop = _dispatch(request.method, request.params)
            response = {"id": request_id, "ok": True, "result": result}
        except (json.JSONDecodeError, ProtocolError) as error:
            response = {
                "id": request_id,
                "ok": False,
                "error": {"code": "invalid-request", "message": str(error)},
            }
        except Exception as error:  # Keep one bad request from killing the worker.
            response = {
                "id": request_id,
                "ok": False,
                "error": {"code": "internal-error", "message": str(error)},
            }
        stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        stdout.flush()
        if stop:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
