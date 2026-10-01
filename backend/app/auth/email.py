import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import aiosmtplib

from ..config import get_settings

logger = logging.getLogger("auth.email")


async def send_otp_email(to_email: str, code: str) -> None:
    settings = get_settings()

    if not settings.smtp_host or not settings.smtp_user:
        logger.warning(f"[DEV] OTP for {to_email}: {code}  (SMTP not configured — printed to log)")
        return

    html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="420" cellpadding="0" cellspacing="0"
             style="background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:36px">
        <tr><td>
          <div style="color:#76b900;font-size:18px;font-weight:700;margin-bottom:8px">Lab Manager</div>
          <div style="color:#888;font-size:13px;margin-bottom:28px">Raritan PDU + KVM control</div>
          <div style="color:#ccc;font-size:14px;margin-bottom:20px">Your one-time verification code:</div>
          <div style="background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;
                      padding:20px;text-align:center;margin-bottom:24px">
            <span style="font-size:40px;font-weight:700;letter-spacing:16px;color:#fff;font-family:monospace">
              {code}
            </span>
          </div>
          <div style="color:#555;font-size:12px;line-height:1.6">
            This code expires in <strong style="color:#888">10 minutes</strong>.
            If you didn&rsquo;t request this, you can safely ignore it.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""

    plain = f"Your Lab Manager verification code is: {code}\n\nExpires in 10 minutes."

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Your verification code"
    msg["From"] = settings.from_email or settings.smtp_user
    msg["To"] = to_email
    msg.attach(MIMEText(plain, "plain"))
    msg.attach(MIMEText(html, "html"))

    await aiosmtplib.send(
        msg,
        hostname=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_user,
        password=settings.smtp_pass,
        start_tls=True,
    )
