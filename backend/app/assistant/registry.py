"""Tool registry: every read-only tool the assistant may use, and the subset a principal is allowed to call.

The tool modules are imported lazily and independently. A module that is missing or fails to import (for
example while it is still being written) is logged and skipped, so the assistant keeps working with the tools
that are available. Invalid tool declarations are skipped too (fail closed).

Action tools (actions/tools.py: `propose_action`, which only prepares a proposal for the user to confirm) are added
only when the settings handed in say ASSISTANT_ACTIONS_ENABLED=true and the site runs in accounts mode, and only for
a signed-in Operator or Admin; no settings, or an unreadable flag, means off.
"""
from __future__ import annotations

import importlib
import logging

from .. import confirm
from .contracts import ROLE_ORDER, Principal, ToolSpec

log = logging.getLogger(__name__)

# Order matters only for duplicate names (the first declaration wins).
TOOL_MODULES = ("tools_status", "tools_layout", "analysis")
# Loaded after the read-only modules, and only when actions_enabled(settings) is true.
ACTION_TOOL_MODULES = ("actions.tools",)


def actions_enabled(settings) -> bool:
    """ASSISTANT_ACTIONS_ENABLED in accounts mode (ORCA-SEC-ACTIONS D1), read with getattr. Fail closed: anything
    but a real True flag with confirm.password_mode == "account" (None settings, missing attributes) is off."""
    try:
        return (getattr(settings, "assistant_actions_enabled", False) is True
                and getattr(settings, "accounts_enabled", False) is True
                and confirm.password_mode(settings) == "account")
    except Exception:  # noqa: BLE001 - an unreadable settings object means "off"
        return False


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


def all_tools(settings=None) -> list[ToolSpec]:
    """tools_status.TOOLS + tools_layout.TOOLS + analysis.TOOLS (+ actions.tools.TOOLS when the settings enable
    assistant actions), skipping missing modules and invalid specs."""
    result: list[ToolSpec] = []
    seen: set[str] = set()
    modules = tuple(TOOL_MODULES) + (tuple(ACTION_TOOL_MODULES) if actions_enabled(settings) else ())
    for module_name in modules:
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


def tools_for(principal: Principal, settings=None) -> list[ToolSpec]:
    """The tools this principal's role may call (a Viewer never receives an Operator tool). Action tools are
    included only when `settings` enables assistant actions in accounts mode (the chat router passes its settings)
    and only for a signed-in Operator or Admin (never a legacy shared-password principal)."""
    if principal.legacy or not principal.allows("Operator"):
        settings = None   # no action tools
    return [spec for spec in all_tools(settings) if principal.allows(spec.required_role)]


def tool_names(tools: list[ToolSpec]) -> list[str]:
    return [spec.name for spec in tools]
