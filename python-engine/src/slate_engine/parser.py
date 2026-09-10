"""Lossless Python structure extraction backed by LibCST."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import Any
from uuid import NAMESPACE_URL, uuid5

import libcst as cst
from libcst.metadata import MetadataWrapper, PositionProvider


ANNOTATION_START = "## @slate"
ANNOTATION_END = "## @slate-end"


def _utf16_col(line: str, codepoint_col: int) -> int:
    return len(line[:codepoint_col].encode("utf-16-le")) // 2


@dataclass(frozen=True)
class SourceText:
    value: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "lines", self.value.splitlines(keepends=True) or [""])

    def position(self, line: int, column: int) -> dict[str, int]:
        text = self.lines[line - 1]
        return {"line": line - 1, "character": _utf16_col(text, column)}

    def range(self, code_range: Any) -> dict[str, dict[str, int]]:
        return {
            "start": self.position(code_range.start.line, code_range.start.column),
            "end": self.position(code_range.end.line, code_range.end.column),
        }


def _annotation_before(
    source: SourceText, anchor_line: int
) -> tuple[dict[str, Any] | None, dict[str, dict[str, int]] | None]:
    """Read a contiguous v2 annotation ending immediately above a declaration."""

    raw_lines = source.value.splitlines()
    end_index = anchor_line - 2
    if end_index < 0 or raw_lines[end_index].strip() != ANNOTATION_END:
        return None, None

    start_index = end_index - 1
    while start_index >= 0 and not raw_lines[start_index].strip().startswith(ANNOTATION_START):
        start_index -= 1
    if start_index < 0:
        return None, None

    first = raw_lines[start_index].strip()
    fields: dict[str, Any] = {"version": None, "unknown": {"tag": {}, "fields": {}}}
    for token in first[len(ANNOTATION_START) :].strip().split():
        if "=" not in token:
            continue
        key, value = token.split("=", 1)
        if key == "v":
            try:
                fields["version"] = int(value)
            except ValueError:
                fields["version"] = value
        elif key == "id":
            fields["id"] = value
        else:
            fields["unknown"]["tag"][key] = value

    repeated: dict[str, list[str]] = {}
    for line in raw_lines[start_index + 1 : end_index]:
        stripped = line.strip()
        if not stripped.startswith("## ") or ":" not in stripped:
            continue
        key, value = stripped[3:].split(":", 1)
        repeated.setdefault(key.strip(), []).append(value.lstrip())

    known = {"intent", "contract", "depends-on", "example", "locked"}
    for key, values in repeated.items():
        if key == "depends-on":
            fields["dependencies"] = values
        elif key == "example":
            fields["examples"] = values
        elif key == "locked":
            fields["locked"] = values[-1].lower() == "true"
        elif key in known:
            fields[key.replace("-", "_")] = "\n".join(values)
        else:
            fields["unknown"]["fields"][key] = values

    annotation_range = {
        "start": {"line": start_index, "character": 0},
        "end": {"line": end_index + 1, "character": 0},
    }
    return fields, annotation_range


class StructureVisitor(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (PositionProvider,)

    def __init__(self, source: SourceText, path: str) -> None:
        self.source = source
        self.path = path
        self.module = cst.Module([])
        self.units: list[dict[str, Any]] = []
        self.stack: list[dict[str, Any]] = []

    def _add_unit(
        self, node: cst.FunctionDef | cst.ClassDef, base_kind: str
    ) -> dict[str, Any]:
        node_range = self.get_metadata(PositionProvider, node)
        name_range = self.get_metadata(PositionProvider, node.name)
        decorator_ranges = [self.get_metadata(PositionProvider, d) for d in node.decorators]
        anchor_line = min(
            [node_range.start.line, *(r.start.line for r in decorator_ranges)]
        )
        annotation, annotation_range = _annotation_before(self.source, anchor_line)

        parent = self.stack[-1] if self.stack else None
        qualified_name = f"{parent['qualifiedName']}.{node.name.value}" if parent else node.name.value
        if base_kind == "class":
            kind = "nested_class" if parent else "class"
        elif parent and parent["kind"] in {"class", "nested_class"}:
            kind = "method"
        elif parent:
            kind = "nested_function"
        else:
            kind = "function"

        durable_id = annotation.get("id") if annotation else None
        unit_id = durable_id or str(
            uuid5(NAMESPACE_URL, f"slate:{self.path}:{kind}:{qualified_name}")
        )
        declaration_range = self.source.range(node_range)
        if decorator_ranges:
            first_decorator = min(
                decorator_ranges,
                key=lambda value: (value.start.line, value.start.column),
            )
            declaration_range = {
                "start": self.source.position(
                    first_decorator.start.line, first_decorator.start.column
                ),
                "end": declaration_range["end"],
            }
        full_range = declaration_range
        if annotation_range:
            full_range = {"start": annotation_range["start"], "end": declaration_range["end"]}

        unit: dict[str, Any] = {
            "id": unit_id,
            "identity": "durable" if durable_id else "provisional",
            "kind": kind,
            "name": node.name.value,
            "qualifiedName": qualified_name,
            "parentId": parent["id"] if parent else None,
            "ranges": {
                "name": self.source.range(name_range),
                "declaration": declaration_range,
                "annotation": annotation_range,
                "full": full_range,
            },
            "annotation": annotation,
            "decorators": [self.module.code_for_node(d.decorator) for d in node.decorators],
        }
        if isinstance(node, cst.FunctionDef):
            params = self.module.code_for_node(node.params)
            returns = (
                self.module.code_for_node(node.returns.annotation)
                if node.returns is not None
                else None
            )
            prefix = "async def" if node.asynchronous is not None else "def"
            unit.update(
                {
                    "async": node.asynchronous is not None,
                    "parameters": params,
                    "returnAnnotation": returns,
                    "signature": f"{prefix} {node.name.value}({params})"
                    + (f" -> {returns}" if returns else ""),
                }
            )
        self.units.append(unit)
        return unit

    def visit_ClassDef(self, node: cst.ClassDef) -> bool:
        self.stack.append(self._add_unit(node, "class"))
        return True

    def leave_ClassDef(self, original_node: cst.ClassDef) -> None:
        self.stack.pop()

    def visit_FunctionDef(self, node: cst.FunctionDef) -> bool:
        self.stack.append(self._add_unit(node, "function"))
        return True

    def leave_FunctionDef(self, original_node: cst.FunctionDef) -> None:
        self.stack.pop()


def parse_module(source: str, path: str = "<memory>") -> dict[str, Any]:
    """Parse one exact source snapshot without modifying it."""

    digest = sha256(source.encode("utf-8")).hexdigest()
    try:
        module = cst.parse_module(source)
    except cst.ParserSyntaxError as error:
        return {
            "path": path,
            "sourceHash": f"sha256:{digest}",
            "valid": False,
            "units": [],
            "diagnostics": [
                {
                    "code": "python-syntax",
                    "message": str(error),
                    "range": {
                        "start": {
                            "line": max(error.raw_line - 1, 0),
                            "character": max(error.editor_column - 1, 0),
                        },
                        "end": {
                            "line": max(error.raw_line - 1, 0),
                            "character": max(error.editor_column - 1, 0),
                        },
                    },
                }
            ],
        }

    wrapped = MetadataWrapper(module, unsafe_skip_copy=True)
    visitor = StructureVisitor(SourceText(source), path)
    wrapped.visit(visitor)
    diagnostics: list[dict[str, Any]] = []
    durable_ids: dict[str, list[dict[str, Any]]] = {}
    for unit in visitor.units:
        if unit["identity"] == "durable":
            durable_ids.setdefault(unit["id"], []).append(unit)
    for unit_id, matches in durable_ids.items():
        if len(matches) > 1:
            diagnostics.append(
                {
                    "code": "duplicate-slate-id",
                    "message": f"Slate id {unit_id} is attached to {len(matches)} declarations.",
                    "range": matches[1]["ranges"]["annotation"],
                }
            )
    return {
        "path": path,
        "sourceHash": f"sha256:{digest}",
        "valid": True,
        "units": visitor.units,
        "diagnostics": diagnostics,
    }
