from __future__ import annotations

from uuid import uuid4

import pytest

from slate_engine import parse_module
from slate_engine.patcher import (
    propose_adopt_unit,
    propose_insert_stub,
    propose_replace_unit,
    propose_update_annotation,
    source_hash,
)
from slate_engine.protocol import ProtocolError


def annotation(unit_id: str | None = None, **overrides: object) -> dict:
    value = {
        "id": unit_id or str(uuid4()),
        "intent": "Do the work.",
        "contract": "Return a typed result.",
        "dependencies": [],
        "examples": ["1 => 2"],
        "locked": False,
    }
    value.update(overrides)
    return value


def find(result: dict, qualified_name: str) -> dict:
    return next(unit for unit in result["units"] if unit["qualifiedName"] == qualified_name)


def test_adopt_decorated_unit_adds_annotation_before_decorator_only() -> None:
    source = "# keep\n@cache\ndef work(value: int) -> int:\n    return value\n"
    parsed = parse_module(source, "work.py")
    target = find(parsed, "work")
    durable_id = str(uuid4())

    proposal = propose_adopt_unit(
        source,
        "work.py",
        parsed["sourceHash"],
        target["id"],
        annotation(durable_id),
    )

    assert proposal["proposedSource"].startswith(
        f"# keep\n## @slate v=2 id={durable_id}\n"
    )
    assert "## @slate-end\n@cache\ndef work" in proposal["proposedSource"]
    adopted = find(proposal["parsed"], "work")
    assert adopted["id"] == durable_id
    assert len(proposal["edits"]) == 1


def test_update_annotation_preserves_unknown_fields_when_supplied() -> None:
    unit_id = str(uuid4())
    source = f'''## @slate v=2 id={unit_id} extra=tag
## intent: Before.
## future: keep me
## locked: false
## @slate-end
def work(value: int) -> int:
    return value
'''
    parsed = parse_module(source, "work.py")
    old = find(parsed, "work")["annotation"]
    updated = {**old, "intent": "After."}
    proposal = propose_update_annotation(
        source, "work.py", parsed["sourceHash"], unit_id, updated
    )
    assert "extra=tag" in proposal["proposedSource"]
    assert "## future: keep me" in proposal["proposedSource"]
    assert "## intent: After." in proposal["proposedSource"]


def test_insert_top_level_typed_stub_into_file_without_final_newline() -> None:
    source = "VALUE = 1"
    proposal = propose_insert_stub(
        source,
        "module.py",
        source_hash(source),
        "def calculate(values: dict[str, int], /, *, scale: float = 1.0) -> float",
        annotation(),
    )
    assert proposal["proposedSource"].startswith("VALUE = 1\n\n## @slate")
    assert 'raise NotImplementedError("Slate stub")' in proposal["proposedSource"]
    assert find(proposal["parsed"], "calculate")["identity"] == "durable"


def test_insert_method_stub_inside_class() -> None:
    source = "class Service:\n    value = 1\n"
    parsed = parse_module(source, "service.py")
    parent = find(parsed, "Service")
    proposal = propose_insert_stub(
        source,
        "service.py",
        parsed["sourceHash"],
        "async def fetch(self, key: str) -> bytes",
        annotation(),
        parent["id"],
    )
    method = find(proposal["parsed"], "Service.fetch")
    assert method["kind"] == "method"
    assert method["async"] is True
    assert "\n    ## @slate" in proposal["proposedSource"]


@pytest.mark.parametrize(
    "signature, message",
    [
        ("def missing(value: int)", "return annotation"),
        ("def missing(value) -> int", "requires a type annotation"),
        ("class Wrong", "top-level function"),
    ],
)
def test_insert_stub_rejects_incomplete_contracts(signature: str, message: str) -> None:
    with pytest.raises(ProtocolError, match=message):
        propose_insert_stub("", "x.py", source_hash(""), signature, annotation())


def test_replace_unit_preserves_annotation_and_unrelated_source() -> None:
    unit_id = str(uuid4())
    source = f'''UNCHANGED = "\U0001f600"

## @slate v=2 id={unit_id}
## intent: Increment.
## locked: false
## @slate-end
def increment(value: int) -> int:
    raise NotImplementedError("Slate stub")

TAIL = 2
'''
    replacement = "def increment(value: int) -> int:\n    return value + 1"
    proposal = propose_replace_unit(
        source, "math.py", source_hash(source), unit_id, replacement
    )
    assert proposal["proposedSource"].startswith(f'UNCHANGED = "\U0001f600"\n\n## @slate')
    assert proposal["proposedSource"].endswith("\nTAIL = 2\n")
    assert "return value + 1" in proposal["proposedSource"]
    assert len(proposal["edits"]) == 1


def test_replace_method_handles_indentation() -> None:
    unit_id = str(uuid4())
    source = f'''class Service:
    ## @slate v=2 id={unit_id}
    ## intent: Fetch.
    ## locked: false
    ## @slate-end
    def fetch(self, key: str) -> bytes:
        raise NotImplementedError
'''
    replacement = "def fetch(self, key: str) -> bytes:\n    return key.encode()"
    proposal = propose_replace_unit(
        source, "service.py", source_hash(source), unit_id, replacement
    )
    assert "    def fetch(self, key: str) -> bytes:\n        return key.encode()" in proposal["proposedSource"]
    assert proposal["parsed"]["valid"] is True


def test_replace_rejects_lock_signature_changes_and_stale_source() -> None:
    unit_id = str(uuid4())
    source = f'''## @slate v=2 id={unit_id}
## intent: Keep.
## locked: true
## @slate-end
def work(value: int) -> int:
    return value
'''
    with pytest.raises(ProtocolError, match="locked"):
        propose_replace_unit(
            source,
            "work.py",
            source_hash(source),
            unit_id,
            "def work(value: int) -> int:\n    return value + 1",
        )
    with pytest.raises(ProtocolError, match="stale source"):
        propose_insert_stub(
            source, "work.py", "sha256:stale", "def other() -> None", annotation()
        )


def test_duplicate_durable_ids_are_diagnostic_and_ambiguous_for_writes() -> None:
    unit_id = str(uuid4())
    block = f"## @slate v=2 id={unit_id}\n## locked: false\n## @slate-end\n"
    source = block + "def first() -> None:\n    pass\n\n" + block + "def second() -> None:\n    pass\n"
    parsed = parse_module(source, "duplicate.py")
    assert parsed["diagnostics"][0]["code"] == "duplicate-slate-id"
    with pytest.raises(ProtocolError, match="resolved to 2"):
        propose_replace_unit(
            source,
            "duplicate.py",
            parsed["sourceHash"],
            unit_id,
            "def first() -> None:\n    return None",
        )
