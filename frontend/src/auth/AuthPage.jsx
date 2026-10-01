import { useState } from "react";
import OTPScreen from "./OTPScreen";

export default function AuthPage() {
  const [stage, setStage] = useState("entry"); // "entry" | "otp"
  const [email, setEmail] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function handleSendOtp(e) {
    e.preventDefault();
    const addr = emailInput.trim().toLowerCase();
    if (!addr || !addr.includes("@")) {
      setError("Enter a valid email address");
      return;
    }
    setSending(true);
    setError("");
    try {
      const res = await fetch("/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `Error ${res.status}`);
      }
      setEmail(addr);
      setStage("otp");
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function handleGoogleLogin() {
    window.location.href = "/auth/google";
  }

  if (stage === "otp") {
    return <OTPScreen email={email} onBack={() => setStage("entry")} />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-nv-400/15 border border-nv-400/30 flex items-center justify-center mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#76b900" strokeWidth="2.5">
              <path d="M3 12h3l2-7 4 14 2-7h7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-white">Lab Manager</h1>
          <p className="text-sm text-zinc-500 mt-1">Sign in to continue</p>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4">
          {/* Google */}
          <button
            onClick={handleGoogleLogin}
            className="w-full flex items-center justify-center gap-3 bg-white hover:bg-zinc-100 text-zinc-900 font-medium text-sm py-2.5 rounded-xl transition"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-zinc-800" />
            <span className="text-xs text-zinc-600">or</span>
            <div className="flex-1 h-px bg-zinc-800" />
          </div>

          {/* Email OTP */}
          <form onSubmit={handleSendOtp} className="space-y-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Email address</label>
              <input
                type="email"
                value={emailInput}
                onChange={(e) => { setEmailInput(e.target.value); setError(""); }}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full bg-zinc-950 border border-zinc-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-nv-400/60 transition"
              />
            </div>
            {error && (
              <p className="text-xs text-red-400">{error}</p>
            )}
            <button
              type="submit"
              disabled={sending}
              className="w-full bg-nv-400 hover:bg-nv-300 disabled:opacity-50 text-zinc-950 font-semibold text-sm py-2.5 rounded-xl transition"
            >
              {sending ? "Sending…" : "Send verification code"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-zinc-600 mt-5">
          Raritan PX4 · KX III · LX II control
        </p>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}
