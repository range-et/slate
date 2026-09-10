from __future__ import annotations

import io
import json
from uuid import uuid4

from slate_engine import parse_module
from slate_engine.patcher import source_hash
from slate_engine.worker import serve


def run_worker(*requests: str) -> list[dict]:
    output = io.StringIO()
    serve(io.StringIO("\n".join(requests) + "\n"), output)
    return [json.loads(line) for line in output.getvalue().splitlines()]


def test_health_parse_and_shutdown() -> None:
    responses = run_worker(
        '{"id":1,"method":"health","params":{}}',
        '{"id":2,"method":"parseModule","params":{"path":"a.py","source":"def a() -> None:\\n    pass\\n"}}',
        '{"id":3,"method":"shutdown","params":{}}',
    )
    assert responses[0] == {
        "id": 1,
        "ok": True,
        "result": {"protocolVersion": 1, "status": "ok"},
    }
    assert responses[1]["ok"] is True
    assert responses[1]["result"]["units"][0]["name"] == "a"
    assert responses[2]["result"] == {"status": "stopping"}


def test_bad_requests_do_not_kill_the_worker() -> None:
    responses = run_worker(
        "not json",
        '{"id":"bad","method":"parseModule","params":{"source":4}}',
        '{"id":"unknown","method":"nope","params":{}}',
        '{"id":"good","method":"health","params":{}}',
    )
    assert [response["ok"] for response in responses] == [False, False, False, True]
    assert responses[0]["id"] is None
    assert responses[1]["error"]["code"] == "invalid-request"
    assert responses[3]["result"]["status"] == "ok"


def test_protocol_version_and_unknown_fields_are_rejected() -> None:
    responses = run_worker(
        '{"id":1,"protocolVersion":2,"method":"health","params":{}}',
        '{"id":2,"method":"health","params":{},"surprise":true}',
    )
    assert responses[0]["ok"] is False
    assert "unsupported protocolVersion" in responses[0]["error"]["message"]
    assert responses[1]["ok"] is False
    assert "unknown request fields" in responses[1]["error"]["message"]


def test_insert_stub_round_trips_through_worker_protocol() -> None:
    source = "VALUE = 1\n"
    request = {
        "id": "stub",
        "protocolVersion": 1,
        "method": "insertStub",
        "params": {
            "source": source,
            "path": "module.py",
            "expectedHash": source_hash(source),
            "signature": "def calculate(value: int) -> int",
            "annotation": {
                "id": str(uuid4()),
                "intent": "Calculate.",
                "contract": "Return an integer.",
                "dependencies": [],
                "examples": ["1 => 2"],
                "locked": False,
            },
        },
    }
    response = run_worker(json.dumps(request))[0]
    assert response["ok"] is True
    assert response["result"]["parsed"]["units"][0]["name"] == "calculate"


def test_move_unit_round_trips_through_worker_protocol() -> None:
    source = "def work(value: int) -> int:\n    return value\n"
    unit_id = parse_module(source, "source.py")["units"][0]["id"]
    request = {
        "id": "move",
        "protocolVersion": 1,
        "method": "moveUnit",
        "params": {
            "source": source,
            "sourcePath": "source.py",
            "expectedSourceHash": source_hash(source),
            "targetSource": "",
            "targetPath": "target.py",
            "expectedTargetHash": source_hash(""),
            "unitId": unit_id,
            "annotation": {
                "id": str(uuid4()), "intent": "Move.", "contract": "",
                "dependencies": [], "examples": [], "locked": False,
            },
        },
    }

    response = run_worker(json.dumps(request))[0]
    assert response["ok"] is True
    assert response["result"]["source"]["parsed"]["units"] == []
    assert response["result"]["target"]["parsed"]["units"][0]["name"] == "work"
