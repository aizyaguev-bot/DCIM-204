import hashlib
import secrets
import string
from datetime import datetime, timezone, timedelta
from typing import Optional

from jose import JWTError, jwt

from ..config import get_settings


def hash_otp(email: str, code: str) -> str:
    raw = f"{email.lower().strip()}:{code}"
    return hashlib.sha256(raw.encode()).hexdigest()


def verify_otp(email: str, code: str, hashed: str) -> bool:
    return secrets.compare_digest(hash_otp(email, code), hashed)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def generate_otp() -> str:
    return "".join(secrets.choice(string.digits) for _ in range(6))


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def create_access_token(user_id: str, email: str) -> str:
    settings = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": user_id, "email": email, "exp": expire, "type": "access"}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> dict:
    settings = get_settings()
    return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
