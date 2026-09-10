"""Checked, minimal source proposals for Slate graph operations."""

from __future__ import annotations

from hashlib import sha256
from typing import Any
from uuid import UUID

import libcst as cst

from .parser import parse_module
from .protocol import ProtocolError


def source_hash(source: str) -> str:
    return f"sha256:{sha256(source.encode('utf-8')).hexdigest()}"


def _require_fresh(source: str, expected_hash: str) -> None:
    actual = source_hash(source)
    if expected_hash != actual:
        raise ProtocolError(f"stale source: expected {expected_hash}, current {actual}")


def _unit(parsed: dict[str, Any], unit_id: str) -> dict[str, Any]:
    matches = [item for item in parsed["units"] if item["id"] == unit_id]
    if len(matches) != 1:
        raise ProtocolError(
            f"unit id {unit_id!r} resolved to {len(matches)} declarations; expected exactly one"
        )
    return matches[0]


def _line_starts(source: str) -> list[int]:
    starts = [0]
    for index, character in enumerate(source):
        if character == "\n":
            starts.append(index + 1)
    return starts


def _codepoint_column(line: str, utf16_column: int) -> int:
    units = 0
    for index, character in enumerate(line):
        if units == utf16_column:
            return index
        units += 2 if ord(character) > 0xFFFF else 1
        if units > utf16_column:
            raise ProtocolError("source position splits a UTF-16 surrogate pair")
    if units == utf16_column:
        return len(line)
    raise ProtocolError("source position is past end of line")


def _offset(source: str, position: dict[str, int]) -> int:
    starts = _line_starts(source)
    line_number = position["line"]
    if line_number < 0 or line_number >= len(starts):
        raise ProtocolError("source position line is out of range")
    line_start = starts[line_number]
    line_end = source.find("\n", line_start)
    if line_end < 0:
        line_end = len(source)
    line = source[line_start:line_end]
    return line_start + _codepoint_column(line, position["character"])


def _apply_edit(
    source: str, source_range: dict[str, dict[str, int]], new_text: str
) -> str:
    start = _offset(source, source_range["start"])
    end = _offset(source, source_range["end"])
    if start > end:
        raise ProtocolError("source edit range is reversed")
    return source[:start] + new_text + source[end:]


def _proposal(
    source: str,
    source_range: dict[str, dict[str, int]],
    new_text: str,
    path: str,
) -> dict[str, Any]:
    proposed = _apply_edit(source, source_range, new_text)
    reparsed = parse_module(proposed, path)
    if not reparsed["valid"]:
        raise ProtocolError(
            f"proposed edit produces invalid Python: {reparsed['diagnostics'][0]['message']}"
        )
    return {
        "baseSourceHash": source_hash(source),
        "proposedSourceHash": source_hash(proposed),
        "edits": [{"range": source_range, "newText": new_text}],
        "proposedSource": proposed,
        "parsed": reparsed,
    }


def _annotation_lines(annotation: dict[str, Any], indent: str = "") -> str:
    unit_id = annotation.get("id")
    if not isinstance(unit_id, str) or not unit_id:
        raise ProtocolError("annotation.id must be a non-empty string")
    try:
        UUID(unit_id)
    except ValueError as error:
        raise ProtocolError("annotation.id must be a UUID") from error

    unknown = annotation.get("unknown", {"tag": {}, "fields": {}})
    if not isinstance(unknown, dict):
        raise ProtocolError("annotation.unknown must be an object")
    unknown_tags = unknown.get("tag", {})
    unknown_fields = unknown.get("fields", {})
    if not isinstance(unknown_tags, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in unknown_tags.items()
    ):
        raise ProtocolError("annotation.unknown.tag must contain string values")
    if not isinstance(unknown_fields, dict) or not all(
        isinstance(key, str)
        and isinstance(values, list)
        and all(isinstance(value, str) for value in values)
        for key, values in unknown_fields.items()
    ):
        raise ProtocolError("annotation.unknown.fields must contain string arrays")

    tag_suffix = "".join(f" {key}={value}" for key, value in unknown_tags.items())
    lines = [f"{indent}## @slate v=2 id={unit_id}{tag_suffix}"]
    for key in ("intent", "contract"):
        value = annotation.get(key, "")
        if not isinstance(value, str):
            raise ProtocolError(f"annotation.{key} must be a string")
        for line in value.splitlines() or ([""] if value else []):
            lines.append(f"{indent}## {key}: {line}")
    for key, output_key in (("dependencies", "depends-on"), ("examples", "example")):
        values = annotation.get(key, [])
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise ProtocolError(f"annotation.{key} must be an array of strings")
        lines.extend(f"{indent}## {output_key}: {value}" for value in values)
    locked = annotation.get("locked", False)
    if not isinstance(locked, bool):
        raise ProtocolError("annotation.locked must be a boolean")
    for key, values in unknown_fields.items():
        lines.extend(f"{indent}## {key}: {value}" for value in values)
    lines.append(f"{indent}## locked: {'true' if locked else 'false'}")
    lines.append(f"{indent}## @slate-end")
    return "\n".join(lines) + "\n"


def propose_adopt_unit(
    source: str,
    path: str,
    expected_hash: str,
    unit_id: str,
    annotation: dict[str, Any],
) -> dict[str, Any]:
    _require_fresh(source, expected_hash)
    parsed = parse_module(source, path)
    if not parsed["valid"]:
        raise ProtocolError("cannot adopt a unit while the module is invalid")
    target = _unit(parsed, unit_id)
    if target["annotation"] is not None:
        raise ProtocolError("unit already has a Slate annotation")
    start = target["ranges"]["declaration"]["start"]
    line = source.splitlines()[start["line"]]
    indent = line[: len(line) - len(line.lstrip(" \t"))]
    insertion = {"start": {"line": start["line"], "character": 0}, "end": {"line": start["line"], "character": 0}}
    return _proposal(source, insertion, _annotation_lines(annotation, indent), path)


def propose_update_annotation(
    source: str,
    path: str,
    expected_hash: str,
    unit_id: str,
    annotation: dict[str, Any],
) -> dict[str, Any]:
    _require_fresh(source, expected_hash)
    parsed = parse_module(source, path)
    if not parsed["valid"]:
        raise ProtocolError("cannot update annotations while the module is invalid")
    target = _unit(parsed, unit_id)
    source_range = target["ranges"]["annotation"]
    if source_range is None:
        raise ProtocolError("unit has no v2 Slate annotation; adopt it first")
    if target["annotation"].get("version") != 2:
        raise ProtocolError("unsupported Slate annotation version")
    line = source.splitlines()[source_range["start"]["line"]]
    indent = line[: len(line) - len(line.lstrip(" \t"))]
    return _proposal(source, source_range, _annotation_lines(annotation, indent), path)


def _validate_typed_function(source: str) -> None:
    module = cst.parse_module(source)
    if len(module.body) != 1 or not isinstance(module.body[0], cst.FunctionDef):
        raise ProtocolError("stub signature must define exactly one top-level function")
    function = module.body[0]
    if function.returns is None:
        raise ProtocolError("stub signature requires a return annotation")
    parameters = [
        *function.params.posonly_params,
        *function.params.params,
        *function.params.kwonly_params,
    ]
    if isinstance(function.params.star_arg, cst.Param):
        parameters.append(function.params.star_arg)
    if function.params.star_kwarg is not None:
        parameters.append(function.params.star_kwarg)
    for parameter in parameters:
        if parameter.name.value not in {"self", "cls"} and parameter.annotation is None:
            raise ProtocolError(
                f"stub parameter {parameter.name.value!r} requires a type annotation"
            )


def propose_insert_stub(
    source: str,
    path: str,
    expected_hash: str,
    signature: str,
    annotation: dict[str, Any],
    parent_id: str | None = None,
) -> dict[str, Any]:
    _require_fresh(source, expected_hash)
    parsed = parse_module(source, path)
    if not parsed["valid"]:
        raise ProtocolError("cannot insert a stub while the module is invalid")

    signature = signature.strip().removesuffix(":")
    candidate = f"{signature}:\n    raise NotImplementedError(\"Slate stub\")\n"
    candidate_parsed = parse_module(candidate, "<stub>")
    if not candidate_parsed["valid"] or len(candidate_parsed["units"]) != 1:
        raise ProtocolError("signature is not one valid Python function declaration")
    _validate_typed_function(candidate)

    if parent_id is None:
        if source.endswith("\n"):
            position = {"line": source.count("\n"), "character": 0}
        else:
            last_line = source.rsplit("\n", 1)[-1]
            position = {
                "line": source.count("\n"),
                "character": len(last_line.encode("utf-16-le")) // 2,
            }
        separator = "" if not source else ("\n" if source.endswith("\n\n") else "\n\n")
        new_text = separator + _annotation_lines(annotation) + candidate
    else:
        parent = _unit(parsed, parent_id)
        if parent["kind"] not in {"class", "nested_class"}:
            raise ProtocolError("stub parent must be a class")
        end = parent["ranges"]["declaration"]["end"]
        position = end
        parent_line = source.splitlines()[parent["ranges"]["name"]["start"]["line"]]
        parent_indent = parent_line[: len(parent_line) - len(parent_line.lstrip(" \t"))]
        indent = parent_indent + "    "
        body = _annotation_lines(annotation, indent) + "\n".join(
            indent + line if line else line for line in candidate.splitlines()
        ) + "\n"
        new_text = "\n\n" + body
    insertion = {"start": position, "end": position}
    return _proposal(source, insertion, new_text, path)


def propose_replace_unit(
    source: str,
    path: str,
    expected_hash: str,
    unit_id: str,
    replacement: str,
) -> dict[str, Any]:
    _require_fresh(source, expected_hash)
    parsed = parse_module(source, path)
    if not parsed["valid"]:
        raise ProtocolError("cannot replace a unit while the module is invalid")
    target = _unit(parsed, unit_id)
    if target["kind"] not in {"function", "method"}:
        raise ProtocolError("only top-level functions and methods can be replaced")
    if target["annotation"] and target["annotation"].get("locked"):
        raise ProtocolError("locked units cannot be replaced")
    if target["annotation"] and target["annotation"].get("version") != 2:
        raise ProtocolError("unsupported Slate annotation version")

    replacement = replacement.strip() + "\n"
    replacement_parsed = parse_module(replacement, "<replacement>")
    replacements = replacement_parsed["units"]
    if not replacement_parsed["valid"] or len(replacements) != 1:
        raise ProtocolError("replacement must contain exactly one valid function")
    candidate = replacements[0]
    if candidate["kind"] != "function":
        raise ProtocolError("replacement must be a function")
    for field in ("name", "signature", "decorators"):
        if candidate.get(field) != target.get(field):
            raise ProtocolError(f"replacement must preserve {field}")

    source_range = target["ranges"]["declaration"]
    indent_width = source_range["start"]["character"]
    indent = " " * indent_width
    lines = replacement.rstrip("\n").splitlines()
    new_text = lines[0] + "\n" + "\n".join(indent + line for line in lines[1:])
    return _proposal(source, source_range, new_text, path)
