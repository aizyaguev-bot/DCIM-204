"""Shared contracts for assistant actions (v2.40.0). Owned by the lead: workers change nothing here, they ask.

Flow
  1. A proposal is created from a ProposalRequest (by the model tool `propose_action`, the demo responder, or the UI
     through POST /api/assistant/actions/proposals). The server resolves the targets and reads every involved PDU
     live (resolve.build_impact), then stores the proposal (store.create): owner-bound, single use, expires after
     ASSISTANT_ACTION_TTL_SECONDS. The model never executes anything and never sees a password.
  2. The user reviews the exact impact in the UI and confirms: POST .../proposals/{id}/execute {password, phrase?}.
     The router checks the feature flag, role, password mode, typed phrase and password (confirm.verify), claims
     the proposal atomically (pending -> executing), re-checks drift (resolve.check_drift) and runs it
     (runner.execute): inline for small kinds, as a background job with progress for rack/lab/batch kinds.
  3. Every step is an audit event (store.add_event). Results are verified by a live re-read, never assumed.

Module ownership (one owner per file; see .team/briefs/ACT-PLAN.md)
  contracts.py, models.py ............ lead
  resolve.py ......................... ACT-1  targets, impact preview, protected outlets, pins, drift
  power.py ........................... ACT-2  switch / cycle outlets with live verification
  routers/pdu_maintenance.py ......... ACT-3  shutdown_pdu / restore_pdu internal functions
  runner.py .......................... ACT-4  execute a claimed proposal, progress, recovery after restart
  store.py, router.py ................ ACT-5  persistence, public JSON, HTTP API, role rules
  tools.py (+ assistant registry/router/prompts) ACT-6  model tool and proposal ledger
  assistant/demo.py .................. ACT-7  Hebrew commands in demo mode
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

# ---------------------------------------------------------------------------------------------------------------
# Kinds
# ---------------------------------------------------------------------------------------------------------------
Scope = Literal["outlet", "server", "pdu", "rack", "lab", "batch"]
Switch = Literal["off", "on", "cycle", "maintenance_off", "maintenance_on", "none", "data"]
# "data": no power change — PDU/KVM port labels and rack positions change (devices move-server / clear).


@dataclass(frozen=True)
class KindSpec:
    kind: str
    scope: Scope
    switch: Switch
    required_role: str        # Viewer | Operator | Admin (checked in the router, not only by the middleware)
    needs_password: bool      # confirm.verify with the user's own password (accounts) or the shared password
    needs_phrase: bool        # the user must type the exact proposal phrase
    accounts_only: bool       # refused unless confirm.password_mode(settings) == "account" (True for every kind: D1)
    background: bool          # runner.execute runs as a background task; the UI polls progress
    needs_protected: bool     # refused until POWER_PROTECTED_OUTLETS is configured ("none" acknowledges)
    title_he: str             # Hebrew title template; placeholders {server} {pdu} {outlet} {rack}


KIND_SPECS: dict[str, KindSpec] = {s.kind: s for s in (
    # One server = every PDU outlet whose label resolves to that server (all feeds, e.g. PSU1 + PSU2).
    KindSpec("server_off", "server", "off", "Operator", True, False, True, False, False, "כיבוי חשמל לשרת {server}"),
    KindSpec("server_on", "server", "on", "Operator", True, False, True, False, False, "הדלקת חשמל לשרת {server}"),
    KindSpec("server_cycle", "server", "cycle", "Operator", True, False, True, False, False,
             "ריסט חשמל לשרת {server}"),
    # One outlet by PDU + outlet number.
    KindSpec("outlet_off", "outlet", "off", "Operator", True, False, True, False, False, "כיבוי שקע {outlet} ב-{pdu}"),
    KindSpec("outlet_on", "outlet", "on", "Operator", True, False, True, False, False, "הדלקת שקע {outlet} ב-{pdu}"),
    KindSpec("outlet_cycle", "outlet", "cycle", "Operator", True, False, True, False, False,
             "ריסט לשקע {outlet} ב-{pdu}"),
    # One PDU into / out of maintenance (same semantics and restore list as the Maintenance column).
    KindSpec("pdu_shutdown", "pdu", "maintenance_off", "Operator", True, False, True, False, True,
             "השבתת {pdu} לתחזוקה"),
    KindSpec("pdu_restore", "pdu", "maintenance_on", "Operator", True, False, True, False, False,
             "החזרת {pdu} מתחזוקה"),
    # Many PDUs: Admin + password + typed phrase, accounts mode only, background job, protected outlets kept on.
    KindSpec("rack_shutdown", "rack", "maintenance_off", "Admin", True, True, True, True, True,
             "כיבוי חשמל לכל ארון {rack}"),
    KindSpec("lab_shutdown", "lab", "maintenance_off", "Admin", True, True, True, True, True,
             "כיבוי חשמל לכל המעבדה"),
    # Restore exactly the PDUs that one executed rack/lab shutdown put into maintenance (restore_of), staggered.
    KindSpec("batch_restore", "batch", "maintenance_on", "Admin", True, True, True, True, False,
             "החזרת חשמל אחרי {title}"),
    # No hardware change: a list of KVM console entries for a server; the user clicks to open one.
    KindSpec("open_console", "server", "none", "Operator", False, False, True, False, False,
             "פתיחת KVM לשרת {server}"),
    # Location changes (v2.40.0, owner 2026-10-20: "explain the changes in words and the assistant handles them").
    # Same planner as Admin -> Locations (devices.py move-server, dry run for the preview). No power change, so a
    # confirmation click is enough (no password); the card always shows every label/position change first.
    KindSpec("server_swap", "server", "data", "Operator", False, False, True, False, False,
             "החלפת מיקום בין {server} ל-{target_server}"),
    KindSpec("server_move", "server", "data", "Operator", False, False, True, False, False,
             "העברת {server} למיקום חדש"),
    KindSpec("server_clear", "server", "data", "Operator", False, False, True, False, False,
             "ניקוי השיוך של {server} (PDU ו-KVM)"),
)}

DATA_KINDS = ("server_swap", "server_move", "server_clear")
# server_swap   target_server required; both servers exchange PDU/KVM ports and rack positions (move-server swap=true).
# server_move   either target_server (the mover takes the target's location, the target becomes unplaced: swap=false)
#               or target_ports (+ optional target_rack/target_slot; an occupied slot is refused, never swapped).
# server_clear  every PDU outlet / KVM port of the server gets its default name ("Outlet N" / "Port N"); the rack
#               position is kept. Equivalent to Locations -> Clear location.

# server_cycle / outlet_cycle with then_console=True return the server's console entries after success
# ("reset then open KVM"); the UI shows an "open KVM" button for a user click.

PHRASES = {"rack_shutdown": "{rack} OFF", "lab_shutdown": "LAB OFF", "batch_restore": "{scope} ON"}
# batch_restore {scope} = "LAB" for a lab batch, the rack name for a rack batch. Phrases are ASCII on purpose
# (typed on any keyboard) and compared exactly after str.strip(); the UI shows the phrase to copy.

# ---------------------------------------------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------------------------------------------
STATUSES = ("pending", "executing", "succeeded", "partial", "failed", "cancelled", "expired", "refused",
            "interrupted", "ready")
# ready       open_console only: nothing to execute.
# refused     drift found at execution: nothing was switched; the user must propose again.
# interrupted the process stopped while executing (found at startup by runner.recover_interrupted); the PDUs it
#             already shut down stay in maintenance and remain restorable.
FINAL_STATUSES = ("succeeded", "partial", "failed", "cancelled", "expired", "refused", "interrupted", "ready")

EVENTS = ("proposed", "denied", "throttled", "confirmed", "refused", "executing", "target", "pdu", "aborted",
          "finished", "cancelled", "expired", "interrupted")


# ---------------------------------------------------------------------------------------------------------------
# Value objects (JSON-safe via to_dict). English identifiers; Hebrew only in *_he fields.
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class ProposalRequest:
    kind: str
    server: str | None = None       # as the user said it ("OPT11", "opt11"); resolved by ping_monitor.server_identity
    pdu: str | None = None          # PDU device id or exact device name
    outlet: int | None = None       # 1-based outlet number (outlet_* kinds)
    rack: str | None = None         # Device.rack value (rack_shutdown)
    restore_of: str | None = None   # proposal id of an executed rack/lab shutdown (batch_restore)
    then_console: bool = False      # server_cycle / outlet_cycle: offer the console after success
    reason: str = ""                # the user's words, <= 200 chars, no control characters (audit only)
    # Data kinds only (see DATA_KINDS).
    target_server: str | None = None
    target_ports: list | None = None   # [{"device": "<PDU/KVM id or exact name>", "port": "<n>"}], <= 8 entries
    target_rack: str | None = None
    target_slot: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Target:
    """One outlet that this action will switch."""
    pdu_id: str
    pdu_name: str
    rack: str
    outlet: int
    label: str        # the outlet label at proposal time (pinned)
    server: str       # canonical server name from the label ("OPT11"), "" when the label names no server
    state: str        # live state at proposal time: on | off | cycling | unknown

    def to_dict(self) -> dict:
        return asdict(self)


EXCLUDE_REASONS = ("protected", "maintenance", "disabled", "unreachable", "already_off", "already_on",
                   "unknown_state", "not_in_batch")


@dataclass
class Excluded:
    """An outlet or a whole PDU (outlet=None) inside the scope that this action will NOT switch, and why."""
    pdu_id: str
    pdu_name: str
    rack: str
    outlet: int | None
    label: str
    reason: str       # one of EXCLUDE_REASONS

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Console:
    kvm_id: str
    kvm_name: str
    port: int
    label: str
    console_url: str  # exactly "/api/kvms/{quote(kvm_id, safe='')}/autologin?port={port}"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Impact:
    targets: list[Target] = field(default_factory=list)
    excluded: list[Excluded] = field(default_factory=list)
    pdus: list[str] = field(default_factory=list)       # PDU ids this action switches / puts into maintenance
    servers: list[str] = field(default_factory=list)    # canonical server names whose power changes
    consoles: list[Console] = field(default_factory=list)
    warnings_he: list[str] = field(default_factory=list)
    # Data kinds: the move-server dry-run result shown to the user and re-checked at execution (drift = any difference).
    changes: list[dict] = field(default_factory=list)     # [{device_id, device_name, kind, port, before, after}]
    positions: list[dict] = field(default_factory=list)   # [{server, before: {rack, slot}, after: {rack, slot}}]
    unplaced: list[str] = field(default_factory=list)
    # Server-only pins for drift checks; NEVER sent to the browser or the model (store.to_public drops them).
    # {pdu_id: {"labels_rev": str, "ip": str, "enabled": bool, "maintenance": bool, "on": [int], "known": [int]}}
    pins: dict[str, Any] = field(default_factory=dict)

    def to_dict(self, *, with_pins: bool = False) -> dict:
        data = {"targets": [t.to_dict() for t in self.targets], "excluded": [e.to_dict() for e in self.excluded],
                "pdus": list(self.pdus), "servers": list(self.servers),
                "consoles": [c.to_dict() for c in self.consoles], "warnings_he": list(self.warnings_he),
                "changes": [dict(c) for c in self.changes], "positions": [dict(p) for p in self.positions],
                "unplaced": list(self.unplaced),
                "counts": {"outlets": len(self.targets), "pdus": len(self.pdus), "servers": len(self.servers),
                           "excluded": len(self.excluded)}}
        if with_pins:
            data["pins"] = self.pins
        return data


@dataclass
class TargetResult:
    pdu_id: str
    outlet: int
    ok: bool              # True only when a live re-read confirms the expected state
    state_after: str      # on | off | cycling | unknown
    error: str = ""       # fixed, secret-free English class text (raritan_pdu.safe_error), "" when ok

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PduResult:
    """Per-PDU outcome of a maintenance shutdown/restore inside a rack/lab/batch job."""
    pdu_id: str
    pdu_name: str
    ok: bool
    switched: list[int] = field(default_factory=list)
    failed: list[int] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class ActionError(Exception):
    """A refusal with an HTTP status and a fixed English message (the UI maps `code` to Hebrew).

    code: disabled | forbidden | password_mode | phrase | password | throttled | not_found | expired | not_pending |
          busy | drift | not_resolved | ambiguous | protected | protected_unset | invalid | no_targets
    confirm.verify's 403 "Password is incorrect" -> code "password"; its 429 -> code "throttled" (keep Retry-After).
    """

    def __init__(self, status: int, code: str, message: str, details: list[str] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = list(details or [])   # Hebrew reasons (drift list, ambiguous candidates)

    def to_dict(self) -> dict:
        return {"detail": self.message, "code": self.code, "details": self.details}


# ---------------------------------------------------------------------------------------------------------------
# Public proposal JSON (store.to_public). The browser, the model and the demo responder see only this.
# ---------------------------------------------------------------------------------------------------------------
# {
#   "id": "<32 hex>", "kind": "lab_shutdown", "scope": "lab", "title_he": "...", "status": "pending",
#   "created_at": iso, "expires_at": iso, "created_by": "<username>",
#   "required_role": "Admin", "needs_password": true, "phrase": "LAB OFF" | null, "background": true,
#   "request": ProposalRequest.to_dict() without reason,
#   "impact": Impact.to_dict() (no pins),
#   "progress": {"done": int, "total": int} | null,
#   "result": {"targets": [TargetResult], "pdus": [PduResult], "consoles": [Console], "summary_he": str} | null,
#   "restore_of": "<id>" | null, "can_restore": bool,   # true on an executed rack/lab shutdown with PDUs still down
#   "can_execute": bool                                  # pending, not expired, and the viewer's role allows it
# }

# ---------------------------------------------------------------------------------------------------------------
# Module interfaces (signatures every worker codes against; implementations live in the owning module)
# ---------------------------------------------------------------------------------------------------------------
# resolve.py (ACT-1)
#   async def build_impact(db, req: ProposalRequest, settings, now: float) -> Impact      # raises ActionError
#   async def check_drift(db, kind: str, impact: dict, settings) -> list[str]             # Hebrew reasons; [] = same
#   def protected_outlets(settings, devices) -> set[tuple[str, int]] | None                # None = not configured
#   async def consoles_for(db, server: str) -> list[Console]
#
# power.py (ACT-2)
#   async def switch(session_factory, targets: list[Target], action: "on"|"off", by: str,
#                    on_result=None) -> list[TargetResult]
#   async def cycle(session_factory, targets: list[Target], by: str, *, off_seconds: float,
#                   sleep=asyncio.sleep, on_result=None) -> list[TargetResult]
#   on_result: optional async callback(TargetResult) used by the runner for audit/progress.
#
# routers/pdu_maintenance.py (ACT-3)
#   async def shutdown_pdu(db, device_id: str, by: str, reason: str, *, exclude: frozenset[int] = frozenset(),
#                          expected_on: frozenset[int] | None = None) -> dict    # same JSON as the endpoint
#   async def restore_pdu(db, device_id: str, by: str) -> dict
#   Both raise MaintenanceConflict (409-type) / MaintenanceDrift / MaintenanceUnavailable (502-type) instead of
#   HTTPException; the HTTP endpoints map them to the same responses as today.
#
# runner.py (ACT-4)
#   async def execute(proposal_id: str, by: str, *, session_factory, settings, sleep=asyncio.sleep) -> dict
#   async def recover_interrupted(session_factory) -> int
#   def start_background(proposal_id, by, *, session_factory, settings) -> None   # keeps a task reference
#
# store.py (ACT-5)
#   def owner_key(principal) -> str              # user id, or "shared:<username>" for legacy/shared mode
#   async def create(db, principal, req, impact: Impact, settings, now, conversation_id=None) -> row
#   async def get_for(db, principal, proposal_id) -> row | None     # owner, or any for Admin
#   async def list_for(db, principal, limit=20) -> list[row]
#   async def claim(db, principal, proposal_id, now) -> row         # atomic pending -> executing, else ActionError
#   async def cancel(db, principal, proposal_id, now) -> row
#   async def add_event(db, proposal_id, actor, event, detail: dict) -> None
#   async def set_progress(db, proposal_id, done, total) -> None
#   async def finish(db, proposal_id, status, result: dict) -> None
#   def to_public(row, principal) -> dict
#   async def propose(session_factory, principal, req, settings, now, conversation_id=None) -> dict  # public
#
# tools.py (ACT-6): ToolSpec "propose_action" (Operator) -> store.propose, appends the id to ctx.proposals.
