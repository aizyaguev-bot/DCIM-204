import base64
from cryptography.fernet import Fernet
from .config import get_settings

def _get_fernet() -> Fernet:
    key = get_settings().lab_manager_master_key
    if not key:
        # Dev fallback: generate a deterministic key from a fixed seed so the
        # app starts without a configured master key, but warn loudly.
        import warnings
        warnings.warn(
            "LAB_MANAGER_MASTER_KEY is not set — using insecure dev key. "
            "Set a real key before using in production.",
            stacklevel=2,
        )
        import hashlib
        key = base64.urlsafe_b64encode(hashlib.sha256(b"lab-manager-dev-key").digest())
    if isinstance(key, str):
        key = key.encode()
    return Fernet(key)

def encrypt(plaintext: str) -> str:
    return _get_fernet().encrypt(plaintext.encode()).decode()

def decrypt(ciphertext: str) -> str:
    return _get_fernet().decrypt(ciphertext.encode()).decode()
