import uuid
import logging
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..database import get_db
from ..models import User, OtpCode, RefreshToken
from .utils import (
    hash_otp, verify_otp, hash_token,
    generate_otp, generate_refresh_token,
    create_access_token, decode_access_token,
)
from .email import send_otp_email

logger = logging.getLogger("auth")
router = APIRouter(prefix="/auth", tags=["auth"])

_COOKIE_NAME = "refresh_token"
_OTP_EXPIRE_MINUTES = 10
_OTP_RATE_LIMIT = 3
_OTP_WINDOW_MINUTES = 15


# ─── helpers ──────────────────────────────────────────────────────────────────

def _set_refresh_cookie(response: Response, token: str, expire_days: int) -> None:
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=False,       # flip to True behind HTTPS
        samesite="lax",
        max_age=expire_days * 86400,
        path="/auth",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(key=_COOKIE_NAME, path="/auth")


async def _issue_refresh_token(
    db: AsyncSession,
    user_id: str,
    device_info: str,
    expire_days: int,
) -> str:
    plain = generate_refresh_token()
    now = datetime.now(timezone.utc)
    db.add(RefreshToken(
        id=str(uuid.uuid4()),
        user_id=user_id,
        token=hash_token(plain),
        device_info=device_info[:256],
        created_at=now,
        expires_at=now + timedelta(days=expire_days),
        revoked=False,
    ))
    await db.commit()
    return plain


def _user_dict(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "avatar_url": user.avatar_url,
        "is_verified": user.is_verified,
    }


def _device_info(request: Request) -> str:
    return request.headers.get("User-Agent", "")[:256]


# ─── POST /auth/otp/request ───────────────────────────────────────────────────

class OtpRequestBody(BaseModel):
    email: str


@router.post("/otp/request")
async def otp_request(
    body: OtpRequestBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    email = body.email.strip().lower()
    if not email or "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(400, "Invalid email address")

    window_start = datetime.now(timezone.utc) - timedelta(minutes=_OTP_WINDOW_MINUTES)
    recent = (await db.execute(
        select(OtpCode).where(
            OtpCode.email == email,
            OtpCode.expires_at > window_start,
        )
    )).scalars().all()

    if len(recent) >= _OTP_RATE_LIMIT:
        raise HTTPException(429, "Too many OTP requests — please wait 15 minutes")

    code = generate_otp()
    now = datetime.now(timezone.utc)
    db.add(OtpCode(
        id=str(uuid.uuid4()),
        email=email,
        code=hash_otp(email, code),
        expires_at=now + timedelta(minutes=_OTP_EXPIRE_MINUTES),
        used=False,
    ))
    await db.commit()

    try:
        await send_otp_email(email, code)
    except Exception as exc:
        logger.error(f"Failed to send OTP to {email}: {exc}")
        raise HTTPException(502, "Failed to send email — check SMTP configuration")

    return {"message": "OTP sent"}


# ─── POST /auth/otp/verify ────────────────────────────────────────────────────

class OtpVerifyBody(BaseModel):
    email: str
    code: str


@router.post("/otp/verify")
async def otp_verify(
    body: OtpVerifyBody,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    email = body.email.strip().lower()
    code = body.code.strip()

    if len(code) != 6 or not code.isdigit():
        raise HTTPException(400, "OTP must be exactly 6 digits")

    now = datetime.now(timezone.utc)
    rows = (await db.execute(
        select(OtpCode).where(
            OtpCode.email == email,
            OtpCode.used == False,
            OtpCode.expires_at > now,
        ).order_by(OtpCode.expires_at.desc())
    )).scalars().all()

    matched = next((r for r in rows if verify_otp(email, code, r.code)), None)
    if not matched:
        raise HTTPException(401, "Invalid or expired OTP")

    matched.used = True
    await db.commit()

    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if not user:
        user = User(
            id=str(uuid.uuid4()),
            email=email,
            name=email.split("@")[0],
            avatar_url="",
            google_id="",
            is_verified=True,
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    else:
        user.is_verified = True
        user.updated_at = now
        await db.commit()

    settings = get_settings()
    plain = await _issue_refresh_token(db, user.id, _device_info(request), settings.refresh_token_expire_days)
    _set_refresh_cookie(response, plain, settings.refresh_token_expire_days)
    return {"access_token": create_access_token(user.id, user.email), "user": _user_dict(user)}


# ─── GET /auth/google ─────────────────────────────────────────────────────────

@router.get("/google")
async def google_login():
    settings = get_settings()
    if not settings.google_client_id:
        raise HTTPException(501, "Google OAuth is not configured")

    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "select_account",
    }
    return RedirectResponse("https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params))


# ─── GET /auth/google/callback ────────────────────────────────────────────────

@router.get("/google/callback")
async def google_callback(
    code: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    settings = get_settings()
    if not settings.google_client_id:
        raise HTTPException(501, "Google OAuth is not configured")

    async with httpx.AsyncClient() as client:
        token_res = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": settings.google_redirect_uri,
                "grant_type": "authorization_code",
            },
        )
    if token_res.status_code != 200:
        raise HTTPException(502, "Failed to exchange Google authorization code")

    token_data = token_res.json()
    google_access = token_data.get("access_token")

    async with httpx.AsyncClient() as client:
        info_res = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {google_access}"},
        )
    if info_res.status_code != 200:
        raise HTTPException(502, "Failed to retrieve Google user info")

    info = info_res.json()
    email = info.get("email", "").lower().strip()
    if not email:
        raise HTTPException(400, "No email returned from Google")

    now = datetime.now(timezone.utc)
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()

    if not user:
        user = User(
            id=str(uuid.uuid4()),
            email=email,
            name=info.get("name", "") or email.split("@")[0],
            avatar_url=info.get("picture", ""),
            google_id=info.get("sub", ""),
            is_verified=True,
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    else:
        user.google_id = info.get("sub", "") or user.google_id
        user.name = info.get("name", "") or user.name
        user.avatar_url = info.get("picture", "") or user.avatar_url
        user.is_verified = True
        user.updated_at = now
        await db.commit()

    plain = await _issue_refresh_token(db, user.id, _device_info(request), settings.refresh_token_expire_days)
    access_token = create_access_token(user.id, user.email)

    redirect = RedirectResponse(f"{settings.frontend_url}/#access_token={access_token}")
    redirect.set_cookie(
        key=_COOKIE_NAME,
        value=plain,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=settings.refresh_token_expire_days * 86400,
        path="/auth",
    )
    return redirect


# ─── POST /auth/refresh ───────────────────────────────────────────────────────

@router.post("/refresh")
async def refresh(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    plain = request.cookies.get(_COOKIE_NAME)
    if not plain:
        raise HTTPException(401, "No refresh token cookie")

    now = datetime.now(timezone.utc)
    rt = (await db.execute(
        select(RefreshToken).where(
            RefreshToken.token == hash_token(plain),
            RefreshToken.revoked == False,
            RefreshToken.expires_at > now,
        )
    )).scalar_one_or_none()

    if not rt:
        _clear_refresh_cookie(response)
        raise HTTPException(401, "Refresh token is invalid or expired")

    user = (await db.execute(select(User).where(User.id == rt.user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(401, "User not found")

    # Rotate: revoke old token, issue new one
    rt.revoked = True
    settings = get_settings()
    new_plain = await _issue_refresh_token(db, user.id, _device_info(request), settings.refresh_token_expire_days)
    _set_refresh_cookie(response, new_plain, settings.refresh_token_expire_days)
    return {"access_token": create_access_token(user.id, user.email)}


# ─── POST /auth/logout ────────────────────────────────────────────────────────

@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    plain = request.cookies.get(_COOKIE_NAME)
    if plain:
        rt = (await db.execute(
            select(RefreshToken).where(RefreshToken.token == hash_token(plain))
        )).scalar_one_or_none()
        if rt:
            rt.revoked = True
            await db.commit()
    _clear_refresh_cookie(response)
    return {"message": "Logged out"}


# ─── POST /auth/logout-all ────────────────────────────────────────────────────

@router.post("/logout-all")
async def logout_all(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    try:
        payload = decode_access_token(auth[7:])
        user_id = payload["sub"]
    except Exception:
        raise HTTPException(401, "Invalid access token")

    tokens = (await db.execute(
        select(RefreshToken).where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked == False,
        )
    )).scalars().all()
    for t in tokens:
        t.revoked = True
    await db.commit()
    _clear_refresh_cookie(response)
    return {"message": "Logged out from all devices"}


# ─── GET /auth/me ─────────────────────────────────────────────────────────────

@router.get("/me")
async def get_me(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    try:
        payload = decode_access_token(auth[7:])
        user_id = payload["sub"]
    except Exception:
        raise HTTPException(401, "Invalid access token")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    return _user_dict(user)
