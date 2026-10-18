"""Tool registry: every read-only tool the assistant may use, and the subset a principal is allowed to call.

The tool modules are imported lazily and independently. A module that is missing or fails to import (for
example while it is still being written) is logged and skipped, so the assistant keeps working with the tools
that are available. Invalid tool declarations are skipped too (fail closed).
"""
from __future__ import annotations

import importlib
import logging

from .contracts import ROLE_ORDER, Principal, ToolSpec

log = logging.getLogger(__name__)

# Order matters only for duplicate names (the first declaration wins).
TOOL_MODULES = ("tools_status", "tools_layout", "analysis")


def _load(module_name: str) -> list:
    try:
        module = importlib.import_module(f"{__package__}.{module_name}")
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.endswith(f"assistant.{module_name}"):
            log.info("Assistant tool module %s is not available yet; skipping it.", module_name)
        else:
            log.warning("Assistant tool module %s could not import %s; skipping it.", module_name, exc.name)
        return []
    except Exception as exc:  # noqa: BLE001 - a broken module must not take the assistant down
        log.warning("Assistant tool module %s failed to import (%s); skipping it.", module_name, type(exc).__name__)
        return []
    tools = getattr(module, "TOOLS", None)
    if not isinstance(tools, (list, tuple)):
        log.warning("Assistant tool module %s has no TOOLS list; skipping it.", module_name)
        return []
    return list(tools)


def _valid(spec) -> bool:
    if not isinstance(spec, ToolSpec):
        return False
    schema = spec.input_schema
    return (isinstance(spec.name, str) and spec.name.isidentifier() and isinstance(spec.description, str)
            and spec.required_role in ROLE_ORDER and callable(spec.func)
            and isinstance(schema, dict) and schema.get("type") == "object")


def all_tools() -> list[ToolSpec]:
    """tools_status.TOOLS + tools_layout.TOOLS + analysis.TOOLS, skipping missing modules and invalid specs."""
    result: list[ToolSpec] = []
    seen: set[str] = set()
    for module_name in TOOL_MODULES:
        for spec in _load(module_name):
            if not _valid(spec):
                log.warning("Skipping an invalid tool declaration in %s.", module_name)
                continue
            if spec.name in seen:
                log.warning("Skipping duplicate tool %s declared in %s.", spec.name, module_name)
                continue
            seen.add(spec.name)
            result.append(spec)
    return result


def tools_for(principal: Principal) -> list[ToolSpec]:
    """The tools this principal's role may call (a Viewer never receives an Operator tool)."""
    return [spec for spec in all_tools() if principal.allows(spec.required_role)]


def tool_names(tools: list[ToolSpec]) -> list[str]:
    return [spec.name for spec in tools]
