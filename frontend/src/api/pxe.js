// Remote PXE install API (/api/pxe) and pure helpers used by RemoteInstallView.
// Helpers stay free of DOM/React so node --test can import this module.

async function req(method, path, body) {
  const res = await fetch(`/api/pxe${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`${res.status}: ${text}`);
    err.status = res.status;
    try {
      const detail = JSON.parse(text).detail;
      err.detail = typeof detail === "string" ? detail
        : Array.isArray(detail) ? detail.map(e => e?.msg).filter(Boolean).join("; ") || undefined
        : detail && typeof detail === "object" && typeof detail.message === "string" ? detail.message
        : undefined;
    } catch {}
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

const job = id => `/jobs/${encodeURIComponent(id)}`;

export const pxeApi = {
  config:      ()                     => req("GET",  "/config"),
  computers:   ()                     => req("GET",  "/computers"),
  jobs:        ()                     => req("GET",  "/jobs"),
  job:         (id)                   => req("GET",  job(id)),
  createJob:   (payload)              => req("POST", "/jobs", payload),
  start:       (id, password, reason) => req("POST", `${job(id)}/start`, { password, reason }),
  refreshShot: (id)                   => req("POST", `${job(id)}/refresh-screenshot`),
  chooseBoot:  (id, optionId, version) => req("POST", `${job(id)}/choose-boot`, { option_id: optionId, version }),
  chooseGrub:  (id, optionId, version) => req("POST", `${job(id)}/choose-grub`, { option_id: optionId, version }),
  install:     (id, password, rewriteHash) => req("POST", `${job(id)}/install`, { password, rewrite_hash: rewriteHash }),
  cancel:      (id)                   => req("POST", `${job(id)}/cancel`),
  takeover:    (id)                   => req("POST", `${job(id)}/takeover`),
  complete:    (id, password)         => req("POST", `${job(id)}/complete`, { password }),
  acknowledge: (id)                   => req("POST", `${job(id)}/acknowledge`),
};

// Job ids are 32-character hex strings; screens show the first 8 (full id in a tooltip).
export const shortId = id => String(id ?? "").slice(0, 8);

export function screenshotUrl(jobId, seq) {
  return `/api/pxe${job(jobId)}/screenshot?seq=${encodeURIComponent(seq ?? 0)}`;
}

export const TERMINAL_STATES = ["completed", "failed", "cancelled", "manual_takeover"];

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

// Fallback only; the UI prefers job.state_label from the API.
export const STATE_LABELS = {
  draft: "טיוטה",
  rebooting: "מאתחל",
  waiting_for_menu: "ממתין לתפריט",
  waiting_for_choice: "ממתין לבחירה",
  waiting_for_grub: "ממתין לתפריט",
  waiting_for_grub_choice: "ממתין לבחירה",
  updating_urls: "מעדכן כתובות",
  ready_to_install: "מוכן להתקנה",
  installing: "מתקין",
  install_started: "מתקין",
  completed: "ההתקנה הושלמה",
  failed: "נכשל",
  cancelled: "בוטל",
  manual_takeover: "השתלטות ידנית",
};

export function stateLabel(jobOrState) {
  if (jobOrState && typeof jobOrState === "object") return jobOrState.state_label || STATE_LABELS[jobOrState.state] || jobOrState.state || "";
  return STATE_LABELS[jobOrState] || jobOrState || "";
}

export const STEPS = ["מאתחל", "ממתין לתפריט", "ממתין לבחירה", "מעדכן כתובות", "מתקין"];

const STEP_OF = {
  draft: -1,
  rebooting: 0,
  waiting_for_menu: 1,
  waiting_for_choice: 2,
  waiting_for_grub: 1,
  waiting_for_grub_choice: 2,
  updating_urls: 3,
  ready_to_install: 3,
  installing: 4,
  install_started: 4,
  completed: STEPS.length,
};

// Step index in STEPS for a state; -1 before start, STEPS.length when all done, null if unknown.
// Terminal failures use failed_step when the API provides it.
export function stepIndex(state, failedStep) {
  if (state in STEP_OF) return STEP_OF[state];
  if (failedStep && failedStep in STEP_OF) return Math.max(0, Math.min(STEP_OF[failedStep], STEPS.length - 1));
  return null;
}

// Which menu the two menu steps refer to.
export function menuPhase(state) {
  if (["waiting_for_menu", "waiting_for_choice"].includes(state)) return "boot";
  if (["waiting_for_grub", "waiting_for_grub_choice", "updating_urls", "ready_to_install"].includes(state)) return "grub";
  return null;
}

const CAN_KEYS = ["start", "choose_boot", "choose_grub", "install", "cancel", "takeover", "complete", "acknowledge", "refresh_screenshot"];

export function canFlags(jobData) {
  const can = jobData?.can || {};
  return Object.fromEntries(CAN_KEYS.map(k => [k, can[k] === true]));
}

export function asList(data, key) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[key])) return data[key];
  return [];
}

// Options read from the screen: accept {id, label, highlighted} or plain strings.
export function normalizeOptions(options, highlightRow) {
  return (Array.isArray(options) ? options : []).map((o, i) => {
    if (o && typeof o === "object") {
      const id = o.id ?? o.option_id ?? i;
      return {
        id,
        label: String(o.label ?? o.text ?? o.title ?? id),
        highlighted: o.highlighted === true || o.selected === true || (Number.isInteger(highlightRow) && highlightRow === i),
        selectable: o.selectable !== false,
        recommended: o.recommended === true,
      };
    }
    return { id: i, label: String(o), highlighted: Number.isInteger(highlightRow) && highlightRow === i, selectable: true, recommended: false };
  });
}

export function choiceKind(state) {
  if (state === "waiting_for_choice") return "boot";
  if (state === "waiting_for_grub_choice") return "grub";
  return null;
}

export const REBOOT_METHOD_LABELS = {
  manual: "Manual — I restart the computer myself",
  kvm_cad: "Ctrl+Alt+Del via KVM",
  pdu_cycle: "PDU power cycle — cuts power",
};

export function rebootMethods(config) {
  const raw = Array.isArray(config?.reboot_methods) && config.reboot_methods.length ? config.reboot_methods : ["manual"];
  return raw.map(m => {
    if (m && typeof m === "object") {
      const id = m.id ?? m.value;
      return { id, label: m.label || REBOOT_METHOD_LABELS[id] || id };
    }
    return { id: m, label: REBOOT_METHOD_LABELS[m] || m };
  }).filter(m => m.id);
}

// The API sends Unix seconds; ISO strings and milliseconds are also accepted.
// Numbers below 1e12 (year 33658 in ms) are treated as seconds.
export function toMillis(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export function formatCountdown(deadline, now = Date.now()) {
  const end = toMillis(deadline);
  if (!Number.isFinite(end)) return null;
  const total = Math.max(0, Math.floor((end - now) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = n => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function isExpired(deadline, now = Date.now()) {
  const end = toMillis(deadline);
  return Number.isFinite(end) && end <= now;
}

export function isSimulated(jobData, takeoverResult) {
  return jobData?.driver === "simulated" || takeoverResult?.simulated === true || takeoverResult?.job?.driver === "simulated";
}

// Decides which real KVM console may be opened for a job; a simulated job never opens one.
// takeoverResult is the POST /takeover response, or undefined for a job already in manual_takeover.
// Returns { open: {deviceId, port} } or { simulated: true, port } or { missing: true }.
export function takeoverConsole(jobData, takeoverResult) {
  const port = jobData?.kvm_port ?? takeoverResult?.job?.kvm_port ?? null;
  if (isSimulated(jobData, takeoverResult)) return { simulated: true, port };
  const target = parseConsoleUrl(takeoverResult?.console_url);
  if (target) return { open: target };
  if (jobData?.kvm_device_id != null && jobData?.kvm_port != null && jobData.kvm_port !== "" && Number.isInteger(Number(jobData.kvm_port))) {
    return { open: { deviceId: jobData.kvm_device_id, port: Number(jobData.kvm_port) } };
  }
  return { missing: true };
}

// "/api/kvms/{id}/autologin?port=N" → { deviceId, port }; null for anything else.
export function parseConsoleUrl(url) {
  if (typeof url !== "string") return null;
  const m = /^\/api\/kvms\/([^/?#]+)\/autologin\?port=(\d+)$/.exec(url);
  if (!m) return null;
  let deviceId;
  try { deviceId = decodeURIComponent(m[1]); } catch { return null; }
  return { deviceId, port: Number(m[2]) };
}

// Splits text into plain/changed segments using rewrite changes [{key, start, end, before, after}].
// Offsets are trusted only when they match; otherwise the value is searched after "key=".
export function highlightSegments(text, changes, side) {
  const s = typeof text === "string" ? text : "";
  const list = (Array.isArray(changes) ? changes : []).filter(c => c && typeof c[side] === "string" && c[side])
    .slice().sort((a, b) => (Number.isInteger(a.start) ? a.start : 0) - (Number.isInteger(b.start) ? b.start : 0));
  const spans = [];
  let shift = 0;
  for (const c of list) {
    const needle = c[side];
    let at = -1;
    if (Number.isInteger(c.start)) {
      const guess = c.start + (side === "after" ? shift : 0);
      if (s.slice(guess, guess + needle.length) === needle) at = guess;
    }
    if (typeof c.before === "string" && typeof c.after === "string") shift += c.after.length - c.before.length;
    if (at < 0) {
      const keyAt = c.key ? s.indexOf(`${c.key}=`) : -1;
      at = s.indexOf(needle, keyAt < 0 ? 0 : keyAt);
    }
    if (at < 0 || spans.some(sp => at < sp.end && at + needle.length > sp.start)) continue;
    spans.push({ start: at, end: at + needle.length, key: c.key });
  }
  spans.sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const sp of spans) {
    if (sp.start > pos) out.push({ text: s.slice(pos, sp.start), changed: false });
    out.push({ text: s.slice(sp.start, sp.end), changed: true, key: sp.key });
    pos = sp.end;
  }
  if (pos < s.length || out.length === 0) out.push({ text: s.slice(pos), changed: false });
  return out;
}

const FALLBACK_ERRORS = {
  400: "The request was rejected. Check the values and try again.",
  401: "Your session has expired. Sign in again.",
  403: "Not allowed. Check the password and your role.",
  404: "This job no longer exists.",
  409: "The job state changed. It has been reloaded.",
  422: "The request was rejected. Choose a KVM port explicitly.",
  429: "Too many attempts. Wait a few minutes and try again.",
  502: "The device did not respond.",
  503: "Remote install is unavailable on the server.",
};

export function errorText(err) {
  if (err?.detail) return err.detail;
  if (err?.status && FALLBACK_ERRORS[err.status]) return FALLBACK_ERRORS[err.status];
  return err?.status ? `Request failed (HTTP ${err.status}).` : "The request failed. Check the connection and try again.";
}

export function formatWhen(value) {
  if (!value) return "—";
  const ms = toMillis(value);
  if (!Number.isFinite(ms)) return String(value);
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
