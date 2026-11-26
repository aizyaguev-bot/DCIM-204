"""Who is asking the assistant, and whose conversations they may see.

Accounts mode: the signed-in user; conversations belong to the user id. Legacy (shared-password) mode has one shared
principal, so conversations are isolated per browser instead: the first assistant request without a valid client
cookie gets a random 32-byte token (httpOnly, SameSite=Strict, Path=/api/assistant) and the owner key is
"legacy:" + sha256(token). Work items stay team-wide in both modes.
"""
from __future__ import annotations

import hashlib
import re
import secrets

from fastapi import Request, Response

from .. import accounts
from .contracts import Principal

CLIENT_COOKIE = "dcim_assistant_client"
CLIENT_COOKIE_PATH = "/api/assistant"
CLIENT_COOKIE_SECONDS = 180 * 86400
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")   # secrets.token_urlsafe(32)


def principal_for(request: Request, settings) -> Principal:
    """Accounts mode: the signed-in user (the middleware has already checked the role and CSRF).
    Legacy mode: one shared principal with full read access; accounts.account() is never called there."""
    if getattr(settings, "accounts_enabled", False):
        user = accounts.account(request)["user"]
        return Principal(user_id=str(user["id"]), username=str(user["username"]), role=str(user["role"]))
    return Principal(user_id=None, username="shared", role="Admin", legacy=True)


def ensure_client(request: Request, response: Response) -> str:
    """Legacy mode: the browser's assistant token, issued on the response when it is missing or malformed."""
    token = request.cookies.get(CLIENT_COOKIE, "")
    if not _TOKEN.fullmatch(token):
        token = secrets.token_urlsafe(32)
        response.set_cookie(CLIENT_COOKIE, token, max_age=CLIENT_COOKIE_SECONDS, httponly=True, samesite="strict",
                            secure=request.url.scheme == "https", path=CLIENT_COOKIE_PATH)
    request.state.assistant_client = token
    return token


def user_key(principal: Principal, request: Request) -> str:
    """The owner key stored on conversations (and on work items as their creator key)."""
    if not principal.legacy and principal.user_id:
        return principal.user_id
    token = getattr(request.state, "assistant_client", None)
    if not token:   # the router always issues one first; anything else gets an empty, private namespace
        token = secrets.token_urlsafe(32)
    return "legacy:" + hashlib.sha256(token.encode()).hexdigest()


def client_key(request: Request, principal: Principal) -> str:
    """The rate-limit key: the user in accounts mode, the client address in legacy mode (a cookie can be dropped)."""
    if principal.legacy or not principal.user_id:
        host = request.client.host if request.client else "unknown"
        return "ip:" + host
    return "user:" + principal.user_id
