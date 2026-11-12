// Runtime Python trace recorder for Slate live execution (Phase 6, S-600).
export const SLATE_TRACE_PY = `"""
_slate_trace.py - Runtime trace recorder for Slate live flow execution.
Emits structured JSON lines to SLATE_TRACE_FILE for inputs, outputs, errors, and call paths.
"""
import sys
import os
import json
import time
from contextlib import contextmanager

_TRACE_FILE = os.environ.get("SLATE_TRACE_FILE")
_SCOPE_STACK = []

def _safe_serialize(val, max_len=500):
    type_name = type(val).__name__
    try:
        r = repr(val)
        if len(r) > max_len:
            r = r[:max_len] + "... [truncated]"
    except Exception:
        r = f"<{type_name}>"
    json_val = None
    try:
        if isinstance(val, (int, float, str, bool, type(None))):
            json_val = val
        elif isinstance(val, (list, tuple)):
            if len(val) <= 100:
                json_val = [v if isinstance(v, (int, float, str, bool, type(None))) else repr(v) for v in val]
        elif isinstance(val, dict):
            if len(val) <= 100:
                json_val = {str(k): v if isinstance(v, (int, float, str, bool, type(None))) else repr(v) for k, v in val.items()}
    except Exception:
        json_val = None
    return {"type": type_name, "repr": r, "json": json_val}

def _emit_event(event):
    if _TRACE_FILE:
        try:
            with open(_TRACE_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(event) + "\\n")
        except Exception:
            pass

@contextmanager
def scope(instance_id: str):
    _SCOPE_STACK.append(instance_id)
    try:
        yield
    finally:
        if _SCOPE_STACK:
            _SCOPE_STACK.pop()

def _get_path(instance_id: str):
    if _SCOPE_STACK and _SCOPE_STACK[-1] == instance_id:
        return list(_SCOPE_STACK[:-1])
    return list(_SCOPE_STACK)

def trace_input(instance_id: str, port_id: str, val):
    _emit_event({
        "kind": "input",
        "path": _get_path(instance_id),
        "instance": instance_id,
        "port": port_id,
        "val": _safe_serialize(val),
        "time": time.time(),
    })

def trace_output(instance_id: str, port_id: str, val):
    _emit_event({
        "kind": "output",
        "path": _get_path(instance_id),
        "instance": instance_id,
        "port": port_id,
        "val": _safe_serialize(val),
        "time": time.time(),
    })

def trace_error(instance_id: str, error_msg: str):
    _emit_event({
        "kind": "error",
        "path": _get_path(instance_id),
        "instance": instance_id,
        "error": error_msg,
        "time": time.time(),
    })

def trace_flow_output(name: str, val):
    _emit_event({
        "kind": "flow_output",
        "path": list(_SCOPE_STACK),
        "name": name,
        "val": _safe_serialize(val),
        "time": time.time(),
    })

def emit_completed(result):
    _emit_event({
        "kind": "completed",
        "result": _safe_serialize(result),
        "time": time.time(),
    })

def emit_flow_error(error_msg: str):
    _emit_event({
        "kind": "flow_error",
        "error": error_msg,
        "time": time.time(),
    })
`;

export const SLATE_RUN_PY = `"""
_slate_run.py - Entry point runner for executing a compiled Slate flow.
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _slate_trace

def main():
    target_module = os.environ.get("SLATE_TARGET_MODULE")
    target_function = os.environ.get("SLATE_TARGET_FUNCTION")
    inputs_file = os.environ.get("SLATE_INPUTS_FILE")

    inputs = {}
    if inputs_file and os.path.exists(inputs_file):
        try:
            with open(inputs_file, "r", encoding="utf-8") as f:
                inputs = json.load(f)
        except Exception as e:
            print(f"Error loading inputs: {e}", file=sys.stderr)

    if not target_module or not target_function:
        print("Missing SLATE_TARGET_MODULE or SLATE_TARGET_FUNCTION", file=sys.stderr)
        sys.exit(1)

    try:
        mod = __import__(target_module, fromlist=[target_function])
        fn = getattr(mod, target_function)
    except Exception as e:
        print(f"Failed to import {target_module}.{target_function}: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        result = fn(**inputs) if inputs else fn()
        _slate_trace.emit_completed(result)
    except Exception as e:
        _slate_trace.emit_flow_error(f"{type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(2)

if __name__ == "__main__":
    main()
`;
