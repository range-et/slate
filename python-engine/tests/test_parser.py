from __future__ import annotations

from slate_engine import parse_module


def unit(result: dict, name: str) -> dict:
    return next(item for item in result["units"] if item["qualifiedName"] == name)


def test_indexes_functions_classes_methods_nested_and_async() -> None:
    source = '''import functools

def top(value: str) -> int:
    def nested() -> int:
        return len(value)
    return nested()

class Service:
    @functools.cache
    async def fetch(self, key: str) -> bytes:
        return key.encode()
'''
    result = parse_module(source, "src/service.py")

    assert result["valid"] is True
    assert [item["kind"] for item in result["units"]] == [
        "function",
        "nested_function",
        "class",
        "method",
    ]
    assert unit(result, "top")["signature"] == "def top(value: str) -> int"
    assert unit(result, "top.nested")["parentId"] == unit(result, "top")["id"]
    fetch = unit(result, "Service.fetch")
    assert fetch["async"] is True
    assert fetch["signature"] == "async def fetch(self, key: str) -> bytes"
    assert fetch["decorators"] == ["functools.cache"]
    assert fetch["parentId"] == unit(result, "Service")["id"]


def test_v2_annotation_provides_durable_identity_and_contract() -> None:
    source = '''## @slate v=2 id=90ab6379-0438-4d6d-bc83-bd355513f28f extra=kept
## intent: Normalize incoming records.
## contract: Preserve ordering.
## depends-on: dependency-one
## depends-on: dependency-two
## example: [1] => [1]
## locked: true
## future: preserved
## @slate-end
@decorator
def normalize(records: list[int]) -> list[int]:
    raise NotImplementedError
'''
    result = parse_module(source, "normalize.py")
    found = unit(result, "normalize")

    assert found["identity"] == "durable"
    assert found["id"] == "90ab6379-0438-4d6d-bc83-bd355513f28f"
    assert found["annotation"] == {
        "version": 2,
        "id": "90ab6379-0438-4d6d-bc83-bd355513f28f",
        "intent": "Normalize incoming records.",
        "contract": "Preserve ordering.",
        "dependencies": ["dependency-one", "dependency-two"],
        "examples": ["[1] => [1]"],
        "locked": True,
        "unknown": {
            "tag": {"extra": "kept"},
            "fields": {"future": ["preserved"]},
        },
    }
    assert found["ranges"]["annotation"]["start"] == {"line": 0, "character": 0}
    assert found["ranges"]["full"]["start"] == {"line": 0, "character": 0}


def test_marker_text_inside_a_string_is_not_an_annotation() -> None:
    source = '''TEXT = """## @slate v=2 id=wrong
## @slate-end"""
def actual() -> None:
    pass
'''
    found = unit(parse_module(source, "strings.py"), "actual")
    assert found["identity"] == "provisional"
    assert found["annotation"] is None


def test_provisional_identity_is_stable_for_same_path_and_qualified_name() -> None:
    before = parse_module("def work() -> None:\n    pass\n", "work.py")
    after = parse_module("# comment\ndef work() -> None:\n    pass\n", "work.py")
    assert unit(before, "work")["id"] == unit(after, "work")["id"]


def test_ranges_use_zero_based_utf16_columns() -> None:
    source = 'def outer() -> None:\n    def after() -> str:\n        return "\U0001f600"\n'
    result = parse_module(source, "unicode.py")
    after = unit(result, "outer.after")
    assert after["ranges"]["name"]["start"] == {"line": 1, "character": 8}
    # LibCST reports Unicode code points; VS Code positions count UTF-16 code
    # units, so the non-BMP emoji adds one to the declaration's end column.
    assert after["ranges"]["declaration"]["end"] == {"line": 2, "character": 19}


def test_crlf_source_hashes_and_parses_without_normalizing_input() -> None:
    source = "def work(\r\n    value: int,\r\n) -> int:\r\n    return value\r\n"
    result = parse_module(source, "crlf.py")
    assert result["valid"] is True
    assert unit(result, "work")["signature"] == "def work(value: int,\n) -> int"


def test_invalid_source_returns_a_diagnostic_instead_of_raising() -> None:
    result = parse_module("def broken(:\n", "broken.py")
    assert result["valid"] is False
    assert result["units"] == []
    assert result["diagnostics"][0]["code"] == "python-syntax"


def test_empty_module_is_valid() -> None:
    result = parse_module("", "empty.py")
    assert result["valid"] is True
    assert result["units"] == []
