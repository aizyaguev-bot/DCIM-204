import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "./AuthContext";

const OTP_EXPIRE_SECONDS = 600; // 10 minutes
const RESEND_COOLDOWN = 60;

export default function OTPScreen({ email, onBack }) {
  const { applyToken } = useAuth();
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [secondsLeft, setSecondsLeft] = useState(OTP_EXPIRE_SECONDS);
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [resending, setResending] = useState(false);
  const inputRefs = useRef([]);

  // Expiry countdown
  useEffect(() => {
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  // Resend cooldown
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const verify = useCallback(async (code) => {
    setVerifying(true);
    setError("");
    try {
      const res = await fetch("/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Error ${res.status}`);
      applyToken(data.access_token, data.user);
    } catch (err) {
      setError(err.message);
      setDigits(["", "", "", "", "", ""]);
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    } finally {
      setVerifying(false);
    }
  }, [email, applyToken]);

  // Auto-submit when all 6 digits are filled
  useEffect(() => {
    if (digits.every((d) => d !== "")) {
      verify(digits.join(""));
    }
  }, [digits, verify]);

  function handleChange(index, value) {
    if (!/^\d?$/.test(value)) return;
    const next = [...digits];
    next[index] = value;
    setDigits(next);
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index, e) {
    if (e.key === "Backspace") {
      if (digits[index]) {
        const next = [...digits];
        next[index] = "";
        setDigits(next);
      } else if (index > 0) {
        inputRefs.current[index - 1]?.focus();
        const next = [...digits];
        next[index - 1] = "";
        setDigits(next);
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handlePaste(e) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted) return;
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    const focusIdx = Math.min(pasted.length, 5);
    inputRefs.current[focusIdx]?.focus();
  }

  async function handleResend() {
    if (resendCooldown > 0 || resending) return;
    setResending(true);
    setError("");
    try {
      const res = await fetch("/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to resend");
      }
      setDigits(["", "", "", "", "", ""]);
      setSecondsLeft(OTP_EXPIRE_SECONDS);
      setResendCooldown(RESEND_COOLDOWN);
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    } catch (err) {
      setError(err.message);
    } finally {
      setResending(false);
    }
  }

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-nv-400/15 border border-nv-400/30 flex items-center justify-center mb-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#76b900" strokeWidth="2">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-white">Check your email</h1>
          <p className="text-sm text-zinc-500 mt-1 text-center">
            We sent a 6-digit code to<br />
            <span className="text-zinc-300">{email}</span>
          </p>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          {/* Digit inputs */}
          <div className="flex gap-2 justify-center mb-5" onPaste={handlePaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => (inputRefs.current[i] = el)}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={(e) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                autoFocus={i === 0}
                className={`w-11 h-14 text-center text-xl font-bold rounded-xl border bg-zinc-950 text-white transition focus:outline-none
                  ${d ? "border-nv-400/60 text-nv-400" : "border-zinc-700"}
                  ${error ? "border-red-500/60" : ""}
                  focus:border-nv-400/80`}
              />
            ))}
          </div>

          {/* Error */}
          {error && (
            <p className="text-center text-xs text-red-400 mb-3">{error}</p>
          )}

          {/* Timer */}
          <div className={`text-center text-sm mb-4 tabular-nums ${secondsLeft < 60 ? "text-red-400" : "text-zinc-500"}`}>
            {secondsLeft > 0 ? `Expires in ${mm}:${ss}` : "Code expired"}
          </div>

          {/* Verify button */}
          <button
            onClick={() => verify(digits.join(""))}
            disabled={verifying || digits.some((d) => !d)}
            className="w-full bg-nv-400 hover:bg-nv-300 disabled:opacity-40 text-zinc-950 font-semibold text-sm py-2.5 rounded-xl transition mb-3"
          >
            {verifying ? "Verifying…" : "Verify code"}
          </button>

          {/* Resend */}
          <div className="text-center text-sm text-zinc-500">
            Didn't receive it?{" "}
            <button
              onClick={handleResend}
              disabled={resendCooldown > 0 || resending}
              className="text-nv-400 hover:text-nv-300 disabled:text-zinc-600 disabled:cursor-not-allowed transition"
            >
              {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : resending ? "Sending…" : "Resend code"}
            </button>
          </div>
        </div>

        <button
          onClick={onBack}
          className="mt-4 w-full text-center text-sm text-zinc-600 hover:text-zinc-400 transition"
        >
          ← Back
        </button>
      </div>
    </div>
  );
}
