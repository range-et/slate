"""Runtime validation for the newline-delimited worker protocol."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


PROTOCOL_VERSION = 1


class ProtocolError(ValueError):
    """A request does not satisfy the worker wire contract."""


@dataclass(frozen=True)
class Request:
    request_id: str | int
    method: str
    params: dict[str, Any]


def parse_request(value: Any) -> Request:
    if not isinstance(value, dict):
        raise ProtocolError("request must be a JSON object")
    request_id = value.get("id")
    if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
        raise ProtocolError("id must be a string or integer")
    method = value.get("method")
    if not isinstance(method, str) or not method:
        raise ProtocolError("method must be a non-empty string")
    params = value.get("params", {})
    if not isinstance(params, dict):
        raise ProtocolError("params must be a JSON object")
    unknown = set(value) - {"id", "method", "params", "protocolVersion"}
    if unknown:
        raise ProtocolError(f"unknown request fields: {', '.join(sorted(unknown))}")
    version = value.get("protocolVersion", PROTOCOL_VERSION)
    if version != PROTOCOL_VERSION:
        raise ProtocolError(
            f"unsupported protocolVersion {version!r}; expected {PROTOCOL_VERSION}"
        )
    return Request(request_id=request_id, method=method, params=params)


def require_string(params: dict[str, Any], key: str, default: str | None = None) -> str:
    value = params.get(key, default)
    if not isinstance(value, str):
        raise ProtocolError(f"params.{key} must be a string")
    return value


def require_object(params: dict[str, Any], key: str) -> dict[str, Any]:
    value = params.get(key)
    if not isinstance(value, dict):
        raise ProtocolError(f"params.{key} must be a JSON object")
    return value
