import { useEffect, useId, useRef, useState } from "react";
import { useAccounts } from "../../accounts";
import {
  getStatus, sendMessage, listConversations, getConversation, resetConversation, normalizeAnswer, normalizeSources,
  normalizeMessages, normalizeConversations, mergeContext, contextKey, contextLabel, errorText, isRetryable, rateLimitText,
  charCountText, formatAsOf, sourceStatusLabel, knownRacks, shouldReloadStatus, ANSWER_MODES, DEFAULT_MAX_CHARS,
} from "../../api/assistant";
import { answerToSpeech, mergeTranscript } from "../../api/speech";
import {
  getConfig as getActionConfig, createProposal, getProposal, normalizeProposal, mergeProposal, isFinal, consoleTarget,
  configBlockText, insertAfterId, proposalRefs,
} from "../../api/assistantActions";
import { actionPoller } from "../../api/assistantActionProgress";
import AnswerView from "./AnswerView";
import ActionProposalCard from "./ActionProposalCard";
import ActionHistory from "./ActionHistory";
import VoiceControls from "./VoiceControls";
import DraftEditor from "./DraftEditor";
import WorkItemsList from "./WorkItemsList";

// Floating "lab assistant" launcher + non-modal side panel (Hebrew, RTL). Mounted once in App.jsx.
// The conversation lives on the server, per user; the browser keeps only open/closed and the last conversation id.

const OPEN_KEY = "dcim-assistant-open";
const CONVERSATION_KEY = "dcim-assistant-conversation";
const TABS = [["chat", "שיחה"], ["history", "שיחות קודמות"], ["work", "משימות עבודה"]];
const ACTIONS_TAB = ["actions", "פעולות"];

const EXAMPLES = ["מה נפל במעבדה?", "מה לבדוק קודם?", "אילו רכיבים מושפעים מתקלה במתג?", "איפה אפשר להוסיף שרת חדש?"];

function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}
function writeOpen(open) {
  try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch { /* private mode: not remembered */ }
}
function readConversation(userKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(CONVERSATION_KEY) || "null");
    return saved && saved.user === userKey && typeof saved.id === "string" && saved.id ? saved.id : null;
  } catch { return null; }
}
function writeConversation(userKey, id) {
  try {
    if (id) localStorage.setItem(CONVERSATION_KEY, JSON.stringify({ user: userKey, id }));
    else localStorage.removeItem(CONVERSATION_KEY);
  } catch { /* private mode: not remembered */ }
}
const narrowScreen = () => { try { return window.matchMedia("(max-width: 580px)").matches; } catch { return false; } };

function Spinner() {
  return <span aria-hidden="true" className="inline-block h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 border-zinc-600 border-t-nv-400" />;
}

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /><path d="M8.5 11h.01M12 11h.01M15.5 11h.01" />
    </svg>
  );
}

const subtle = "rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-40";

// onOpenConsole(deviceId, port) is App's openKvmConsole: it must run inside a click handler and returns
// "popup" | "inline" | "denied".
export default function AssistantPanel({ context, navigate, openDetail, devices = [], onOpenConsole }) {
  const { mode: accountMode, user, canOperate, canAdmin } = useAccounts();
  // The stored conversation id is keyed by username (SEC-AI-18); another account on this browser never loads it.
  const userKey = accountMode === "accounts" ? `user:${user?.username ?? ""}` : "legacy";
  const baseId = useId();
  const titleId = `${baseId}-title`, inputId = `${baseId}-input`, counterId = `${baseId}-counter`, hintId = `${baseId}-hint`;

  const [open, setOpen] = useState(readOpen);
  const [tab, setTab] = useState("chat");
  const [status, setStatus] = useState(undefined);            // undefined: not loaded yet
  const [statusError, setStatusError] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [conversationId, setConversationId] = useState(() => readConversation(userKey));
  const [loadedId, setLoadedId] = useState(null);             // conversation whose messages are on screen
  const [messages, setMessages] = useState([]);
  const [convLoading, setConvLoading] = useState(false);
  const [convError, setConvError] = useState(null);
  const [history, setHistory] = useState({ loading: false, error: null, list: null });
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(null);               // {question, startedAt}
  const [failed, setFailed] = useState(null);                 // {err, question, rateSeconds?}
  const [rateUntil, setRateUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [extraContext, setExtraContext] = useState(null);
  const [dismissedKey, setDismissedKey] = useState(null);
  const [draft, setDraft] = useState(null);                   // {draft, key}
  const [savedKeys, setSavedKeys] = useState({});
  const [notice, setNotice] = useState(null);                 // {text, work?: true}
  const [workVersion, setWorkVersion] = useState(0);
  // Assistant actions: every proposal shown anywhere in the panel, by id, always the newest server state.
  const [actions, setActions] = useState({});
  const [actionConfig, setActionConfig] = useState(undefined);   // undefined: not loaded, null: unavailable
  const [tabCards, setTabCards] = useState([]);                  // proposals opened from the "פעולות" tab
  const [actionsVersion, setActionsVersion] = useState(0);       // refreshKey for ActionHistory
  const [actionDone, setActionDone] = useState(false);           // an action finished while the panel was closed

  const epochRef = useRef(0);          // bumped on new/other conversation, sign-out: late answers are dropped
  const controllerRef = useRef(null);  // the question in flight (Stop / close abort it)
  const sessionRef = useRef(null);     // aborted when the panel closes: status, conversation and list loads
  const historySeq = useRef(0);
  const statusSeq = useRef(0);         // a newer /status load supersedes an older one still in flight
  const statusAtRef = useRef(null);    // Date.now() of the last successful /status load
  const statusRef = useRef(status);    // latest /status for code that runs after a long await
  statusRef.current = status;
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const launcherRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const tabRefs = useRef({});
  const wasOpen = useRef(open);
  const userRef = useRef(userKey);
  const actionsRef = useRef(actions);   // the map as last written (updates arrive from many places)
  const actionsEpoch = useRef(0);       // bumped on sign-out / another user: late action responses are dropped
  const openRef = useRef(open);
  openRef.current = open;
  const actionConfigSeq = useRef(0);

  const maxChars = Number.isInteger(status?.limits?.max_chars) && status.limits.max_chars > 0 ? status.limits.max_chars : DEFAULT_MAX_CHARS;
  const notInstalled = statusError?.status === 404;
  const blocked = notInstalled || status?.enabled === false;
  const rateRemaining = Math.max(0, Math.ceil((rateUntil - now) / 1000));
  const over = input.trim().length > maxChars;
  const canSend = !pending && !blocked && !!input.trim() && !over && rateRemaining === 0;

  const racks = knownRacks(devices);
  const merged = mergeContext(context, extraContext, { racks });   // a rack is sent only when it is a known rack
  const mergedKey = contextKey(merged);
  const contextOn = !!merged && mergedKey !== dismissedKey;
  const chip = contextOn ? contextLabel(merged, devices) : null;

  const actionsTab = actionConfig?.enabled === true;
  const tabs = actionsTab ? [...TABS, ACTIONS_TAB] : TABS;
  const anyExecuting = Object.values(actions).some(p => p.status === "executing");
  const actionBlock = configBlockText(actionConfig);

  const lastAnswer = [...messages].reverse().find(m => m.role === "assistant");
  const speakText = lastAnswer ? answerToSpeech(lastAnswer.answer) : "";

  // ---- closing the panel (any way: button, Escape, link on a phone, sign-out) aborts everything in flight ----
  useEffect(() => {
    if (!open) return undefined;
    const session = new AbortController();
    sessionRef.current = session;
    return () => {
      session.abort();
      controllerRef.current?.abort();
    };
  }, [open]);

  // ---- persistence (try/catch inside the helpers) ----
  useEffect(() => { writeOpen(open); }, [open]);
  useEffect(() => { writeConversation(userKey, conversationId); }, [userKey, conversationId]);

  // ---- a different signed-in user never sees the previous user's conversation ----
  useEffect(() => {
    if (userRef.current === userKey) return;
    userRef.current = userKey;
    resetActions();
    resetLocal();
    setConversationId(readConversation(userKey));
    setHistory({ loading: false, error: null, list: null });
  }, [userKey]);

  // ---- session expired: stop everything, close, forget the conversation on this device ----
  useEffect(() => {
    const onExpired = () => {
      epochRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      writeOpen(false);
      try { localStorage.removeItem(CONVERSATION_KEY); } catch { /* nothing stored */ }
      statusSeq.current += 1;
      statusAtRef.current = null;
      setOpen(false); setDraft(null); setPending(null); setFailed(null); setMessages([]); setConversationId(null);
      setLoadedId(null); setStatus(undefined); setStatusError(null); setHistory({ loading: false, error: null, list: null });
      resetActionsRef.current();
    };
    window.addEventListener("dcim-session-expired", onExpired);
    return () => window.removeEventListener("dcim-session-expired", onExpired);
  }, []);

  // ---- optional page selection (e.g. a server picked in Racks) via a window event ----
  useEffect(() => {
    const onContext = event => setExtraContext(event?.detail && typeof event.detail === "object" ? event.detail : null);
    window.addEventListener("dcim-assistant-context", onContext);
    return () => window.removeEventListener("dcim-assistant-context", onContext);
  }, []);
  const appKey = contextKey(context);
  useEffect(() => { setExtraContext(null); }, [appKey]);

  // ---- abort an in-flight question when the panel unmounts (sign-out, page change in tests) ----
  useEffect(() => () => { epochRef.current += 1; controllerRef.current?.abort(); actionsEpoch.current += 1; actionPoller?.stopAll?.(); }, []);

  // ---- actions: config once per user (Viewer may read it), updates from the shared poller (ACT-9) ----
  useEffect(() => {
    if (open && actionConfig === undefined) loadActionConfig();
  }, [open, actionConfig]);
  useEffect(() => {
    if (!actionPoller?.onAny) return undefined;
    // The listener gets {id, proposal, polling, stopReason, failures, offlineSince}; only the proposal is kept here.
    const off = actionPoller.onAny(state => { if (state?.proposal) updateRef.current(state.proposal); });
    return typeof off === "function" ? off : undefined;
  }, []);
  useEffect(() => { if (open) setActionDone(false); }, [open]);
  useEffect(() => { if (tab === "actions" && !actionsTab) setTab("chat"); }, [tab, actionsTab]);

  // ---- status, stored conversation ----
  useEffect(() => {
    if (open && status === undefined && !statusLoading && !statusError) loadStatus();
  }, [open, status, statusLoading, statusError]);
  // D1: the server's mode can change at any time (key added, daily cap), so on every open a /status that failed
  // or is older than 60 s is read again; after each answer, see send().
  useEffect(() => {
    if (open && shouldReloadStatus({ status, statusError, loadedAt: statusAtRef.current, opened: true })) loadStatus();
  }, [open]);
  useEffect(() => {
    if (open && conversationId && loadedId !== conversationId && !pending) loadConversation(conversationId);
  }, [open, conversationId, loadedId, pending]);
  useEffect(() => {
    if (open && tab === "history" && !history.list && !history.loading && !history.error) loadHistory();
  }, [open, tab, history]);

  // ---- one-second tick only while waiting for an answer or a rate-limit window ----
  useEffect(() => {
    if (!pending && rateUntil <= Date.now()) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!pending && t >= rateUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [pending, rateUntil]);

  // ---- focus: into the panel on open, back to the launcher on close ----
  useEffect(() => {
    if (open && !wasOpen.current) requestAnimationFrame(() => (inputRef.current && !inputRef.current.disabled ? inputRef.current : panelRef.current)?.focus());
    if (!open && wasOpen.current) requestAnimationFrame(() => launcherRef.current?.focus());
    wasOpen.current = open;
  }, [open]);

  // ---- keep the newest message in view: the top of a new answer, or the end while waiting ----
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const all = log.querySelectorAll("[data-message]");
    const last = all[all.length - 1];
    // Only the log scrolls; the page underneath never moves.
    if (!pending && !failed && last?.dataset.role === "assistant") log.scrollTop += last.getBoundingClientRect().top - log.getBoundingClientRect().top - 8;
    else log.scrollTop = log.scrollHeight;
  }, [messages.length, !!pending, !!failed, tab, open]);

  function resetLocal() {
    epochRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPending(null); setFailed(null); setMessages([]); setLoadedId(null); setConvError(null); setConvLoading(false);
    setSavedKeys({}); setNotice(null);
  }

  async function loadStatus() {
    const seq = ++statusSeq.current;
    setStatusLoading(true); setStatusError(null);
    try {
      const data = await getStatus({ signal: sessionRef.current?.signal });
      if (seq !== statusSeq.current) return;
      statusAtRef.current = Date.now();
      setStatus(data && typeof data === "object" ? data : {});
    } catch (err) {
      if (seq !== statusSeq.current) return;
      if (err.code !== "aborted") setStatusError(err);   // closed while loading: loaded again on the next open
    } finally {
      if (seq === statusSeq.current) setStatusLoading(false);
    }
  }

  async function loadConversation(id) {
    resetLocal();
    const epoch = epochRef.current;
    setLoadedId(id); setConvLoading(true);
    try {
      const data = await getConversation(id, { signal: sessionRef.current?.signal });
      if (epoch !== epochRef.current) return;
      setMessages(withStoredProposals(data));
    } catch (err) {
      if (epoch !== epochRef.current) return;
      if (err.code === "aborted") setLoadedId(null);   // closed while loading: loaded again on the next open
      else if (err.status === 404) {
        setConversationId(null); setLoadedId(null);
        setNotice({ text: "השיחה הקודמת כבר לא קיימת בשרת. אפשר להתחיל שיחה חדשה." });
      } else setConvError(err);
    } finally {
      if (epoch === epochRef.current) setConvLoading(false);
    }
  }

  async function loadHistory() {
    const seq = ++historySeq.current;
    setHistory(h => ({ ...h, loading: true, error: null }));
    try {
      const list = normalizeConversations(await listConversations({ signal: sessionRef.current?.signal }));
      if (seq === historySeq.current) setHistory({ loading: false, error: null, list });
    } catch (err) {
      if (seq === historySeq.current) setHistory(h => ({ ...h, loading: false, error: err.code === "aborted" ? null : err }));
    }
  }

  // ---- assistant actions ----------------------------------------------------------------------------------
  function resetActions() {
    actionsEpoch.current += 1;
    actionConfigSeq.current += 1;
    actionPoller?.stopAll?.();
    actionsRef.current = {};
    setActions({}); setTabCards([]); setActionConfig(undefined); setActionDone(false);
  }
  const resetActionsRef = useRef(resetActions);
  resetActionsRef.current = resetActions;

  async function loadActionConfig() {
    const seq = ++actionConfigSeq.current;
    try {
      const data = await getActionConfig({ signal: sessionRef.current?.signal });
      if (seq === actionConfigSeq.current) setActionConfig(data && typeof data === "object" ? data : null);
    } catch (err) {
      // Closed while loading: read again on the next open. Older server (404) or any failure: no actions UI.
      if (seq === actionConfigSeq.current) setActionConfig(err.code === "aborted" ? undefined : null);
    }
  }

  // Merges one proposal (public JSON or normalized) into the map; stale responses never win (mergeProposal).
  function updateProposal(raw, epoch = actionsEpoch.current) {
    if (epoch !== actionsEpoch.current) return null;
    const p = normalizeProposal(raw);
    if (!p) return null;
    const prev = actionsRef.current[p.id];
    const next = mergeProposal(prev, p);
    if (next === prev) return prev;
    actionsRef.current = { ...actionsRef.current, [p.id]: next };
    setActions(actionsRef.current);
    if (prev?.status === "executing" && next.status !== "executing" && !openRef.current) setActionDone(true);
    if (prev && prev.status !== next.status) setActionsVersion(v => v + 1);
    return next;
  }
  const updateRef = useRef(updateProposal);
  updateRef.current = updateProposal;

  // After execute answered 200 (final) or 202 (running): the shared poller follows it from here.
  function onActionExecuted(p) {
    const next = updateProposal(p);
    if (next) actionPoller?.update?.(next);
    setActionsVersion(v => v + 1);
  }

  // A new proposal made from a card (restore, or the same request again) appears right after that card.
  async function createFrom(source, request) {
    const epoch = actionsEpoch.current;
    const p = normalizeProposal(await createProposal(request));
    if (!p || epoch !== actionsEpoch.current) return p;
    updateProposal(p, epoch);
    setMessages(list => {
      const at = list.findIndex(m => m.proposalIds?.includes(source.id));
      if (at < 0) return list;
      const copy = list.slice();
      copy[at] = { ...copy[at], proposalIds: insertAfterId(copy[at].proposalIds, source.id, p.id) };
      return copy;
    });
    // From the "פעולות" tab (or a card no message shows): the new card is shown in that tab.
    const inMessages = messages.some(m => m.proposalIds?.includes(source.id));
    setTabCards(ids => (ids.includes(source.id) || !inMessages ? insertAfterId(ids, source.id, p.id) : ids));
    setActionsVersion(v => v + 1);
    return p;
  }
  const restoreAction = source => createFrom(source, { kind: "batch_restore", restore_of: source.id });
  const reproposeAction = source => createFrom(source, source.request);

  // Synchronous (inside the click): only an autologin URL of a KVM the site knows, matching the entry (SEC-ACT-18).
  function openConsoleEntry(entry) {
    if (!canOperate) return "denied";
    const target = consoleTarget(entry, devices);
    if (!target || !onOpenConsole) return "invalid";
    const outcome = onOpenConsole(target.deviceId, target.port);
    return ["popup", "inline", "denied"].includes(outcome) ? outcome : "popup";
  }

  // A history row was opened. Its results show inside the row (ActionHistory); a proposal that still waits for a
  // decision (pending, or an open_console one) also gets its full card on top, so it can be confirmed or cancelled
  // even when the conversation that created it is no longer on screen.
  function selectFromHistory(proposal) {
    const p = updateProposal(proposal) || normalizeProposal(proposal);
    if (!p || (p.status !== "pending" && p.status !== "ready")) return;
    setTabCards([p.id]);
    // Read once more so the card starts from the current server state.
    if (!isFinal(p.status)) {
      const epoch = actionsEpoch.current;
      getProposal(p.id).then(fresh => updateProposal(fresh, epoch)).catch(() => {});
    }
    requestAnimationFrame(() => document.getElementById(`${baseId}-panel-actions`)?.scrollTo?.({ top: 0 }));
  }

  // Stored messages: the proposals they refer to (if the server keeps them) are shown again and read once.
  function withStoredProposals(data) {
    const list = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
    const rawMessages = list.filter(m => m && typeof m === "object" && !Array.isArray(m) && (m.role === "user" || m.role === "assistant"));
    const epoch = actionsEpoch.current;
    return normalizeMessages(data).map((m, i) => {
      if (m.role !== "assistant") return m;
      const { ids, proposals } = proposalRefs(rawMessages[i]?.action_proposals);
      if (!ids.length) return m;
      proposals.forEach(p => updateProposal(p, epoch));
      for (const id of ids) {
        const known = proposals.find(p => p.id === id);
        if (known && isFinal(known.status)) continue;
        getProposal(id).then(fresh => updateProposal(fresh, epoch)).catch(() => {});
      }
      return { ...m, proposalIds: ids };
    });
  }

  const actionProps = {
    config: actionConfig, canOperate, canAdmin, onUpdate: updateProposal, onExecuted: onActionExecuted,
    onRestore: restoreAction, onRepropose: reproposeAction, onOpenConsole: openConsoleEntry,
  };

  function startNew() {
    resetLocal();
    setConversationId(null);
    setTab("chat");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function openConversation(id) {
    setTab("chat");
    setConversationId(id);
    if (id !== loadedId || convError) loadConversation(id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function deleteConversation(id) {
    setConfirmDelete(null);
    try {
      await resetConversation(id);
    } catch (err) {
      if (err.status !== 404) { setHistory(h => ({ ...h, error: err })); return; }
    }
    setHistory(h => ({ ...h, error: null, list: (h.list || []).filter(c => c.id !== id) }));
    if (id === conversationRef.current) { resetLocal(); setConversationId(null); }
    setNotice({ text: "השיחה נמחקה." });
  }

  async function send(text, { retry = false } = {}) {
    const question = String(text ?? "").trim();
    if (!question || pending || blocked || question.length > maxChars || rateUntil > Date.now()) return;
    const epoch = epochRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!retry) {
      setMessages(list => [...list, { id: `local-${Date.now()}`, role: "user", text: question, created_at: new Date().toISOString() }]);
      setInput("");
    }
    setFailed(null); setNotice(null); setPending({ question, startedAt: Date.now() });
    try {
      const res = await sendMessage({ conversationId: conversationRef.current, message: question, context: contextOn ? merged : null },
        { signal: controller.signal });
      if (epoch !== epochRef.current) return;
      const cid = typeof res?.conversation_id === "string" && res.conversation_id ? res.conversation_id : conversationRef.current;
      conversationRef.current = cid;
      setConversationId(cid); setLoadedId(cid);
      const proposals = proposalRefs(res?.action_proposals).proposals;
      proposals.forEach(p => updateProposal(p));
      setMessages(list => [...list, {
        proposalIds: proposals.map(p => p.id),
        id: res?.message_id ? String(res.message_id) : `local-a-${Date.now()}`, role: "assistant",
        answer: normalizeAnswer(res?.answer), sources: normalizeSources(res?.sources),
        mode: ANSWER_MODES.includes(res?.mode) ? res.mode : null,
        demo_reason: typeof res?.demo_reason === "string" ? res.demo_reason : null,
        elapsed_ms: Number.isFinite(res?.elapsed_ms) ? res.elapsed_ms : null, created_at: new Date().toISOString(),
      }]);
      setHistory(h => (h.list ? { ...h, list: null } : h));   // the list is reloaded next time it is shown
      // D1: an answer in another mode than /status says (e.g. LLM after a key was added) -> read /status again so the
      // header banner and the egress note match what really answered.
      if (shouldReloadStatus({ status: statusRef.current, answerMode: res?.mode })) loadStatus();
    } catch (err) {
      if (epoch !== epochRef.current) return;
      if (err.status === 429) setRateUntil(Date.now() + (err.retryAfter || 60) * 1000);
      if (err.status === 404 && conversationRef.current) {
        conversationRef.current = null;
        setConversationId(null); setLoadedId(null);
      }
      setFailed({ err, question, rateSeconds: err.status === 429 ? err.retryAfter || 60 : null });
    } finally {
      if (epoch === epochRef.current) {
        setPending(null);
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    }
  }

  function stop() {
    controllerRef.current?.abort();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function openLink(link) {
    if (link.detail) openDetail?.(link.detail);
    else navigate?.(link.tab, link.rack);
    if (narrowScreen()) setOpen(false);
  }

  function onPanelKey(e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Handled here only (never on window), and stopped so page drawers underneath stay open.
    e.preventDefault();
    e.stopPropagation();
    if (confirmDelete) { setConfirmDelete(null); return; }
    setOpen(false);
  }

  function onInputKey(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  }

  function onTabKey(e) {
    const order = tabs.map(([id]) => id);
    const at = order.indexOf(tab);
    // RTL: the next tab is on the left.
    const next = { ArrowLeft: at + 1, ArrowRight: at - 1, Home: 0, End: order.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const id = order[(next + order.length) % order.length];
    setTab(id);
    tabRefs.current[id]?.focus();
  }

  function failureText(f) {
    if (f.err.status === 404) return "השיחה הזו כבר לא קיימת בשרת. לחיצה על \"נסה שוב\" תשלח את השאלה בשיחה חדשה.";
    if (f.err.status === 429) return rateLimitText(f.rateSeconds);
    return errorText(f.err);
  }

  const elapsed = pending ? Math.max(0, Math.floor((now - pending.startedAt) / 1000)) : 0;
  const examples = chip ? [`מה המצב של ${chip.prefix} ${chip.name}?`, ...EXAMPLES] : EXAMPLES;

  return (
    <>
      {!open && (
        <button ref={launcherRef} type="button" onClick={() => setOpen(true)} aria-expanded="false" aria-controls="assistant-panel"
          dir="rtl" lang="he" style={{ left: 16, bottom: "calc(72px + env(safe-area-inset-bottom, 0px))" }}
          className="fixed z-[45] inline-flex items-center gap-2 rounded border border-nv-400/70 bg-zinc-950 px-3.5 py-2.5 text-sm font-semibold text-zinc-100 hover:border-nv-400 hover:bg-zinc-900">
          <span className="text-nv-300"><ChatIcon /></span>
          עוזר המעבדה
          {pending && <span className="h-2 w-2 rounded-full bg-nv-400 motion-safe:animate-pulse" role="img" aria-label="תשובה בהכנה" />}
          {anyExecuting && <span className="h-2 w-2 rounded-full bg-amber-400 motion-safe:animate-pulse" role="img" aria-label="פעולה בביצוע" />}
          {!anyExecuting && actionDone && <span className="h-2 w-2 rounded-full bg-emerald-400" role="img" aria-label="פעולה הסתיימה" />}
        </button>
      )}

      {open && (
        <aside id="assistant-panel" ref={panelRef} role="complementary" aria-labelledby={titleId} dir="rtl" lang="he" tabIndex={-1}
          onKeyDown={onPanelKey}
          className="fixed inset-0 z-[45] flex h-[100dvh] w-full flex-col bg-zinc-950 text-zinc-200 focus:outline-none min-[581px]:inset-auto min-[581px]:bottom-0 min-[581px]:left-0 min-[581px]:top-0 min-[581px]:h-auto min-[581px]:w-[420px] min-[581px]:border-r min-[581px]:border-zinc-800">
          <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <span className="text-nv-300"><ChatIcon /></span>
            <h2 id={titleId} className="text-sm font-bold text-zinc-100">עוזר המעבדה</h2>
            {status?.mode === "llm" && (
              <span className="min-w-0 truncate rounded border border-nv-400/40 bg-nv-400/10 px-1.5 py-0.5 text-[10px] text-nv-300" title="מודל השפה שעונה">
                מודל: <bdi className="font-mono">{status.model || "לא צוין"}</bdi>
              </span>
            )}
            {status?.mode === "demo" && <span className="rounded border border-amber-700 bg-amber-950/50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">הדגמה</span>}
            {statusLoading && <Spinner />}
            <div className="ms-auto flex items-center gap-1.5">
              <button type="button" onClick={startNew} className={subtle} disabled={!messages.length && !conversationId && !pending && !failed}>שיחה חדשה</button>
              <button type="button" onClick={() => setOpen(false)} aria-label="סגור את עוזר המעבדה" title="סגירה (Esc)"
                className="h-7 w-7 rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">✕</button>
            </div>
          </div>

          {status?.mode === "demo" && (
            <div role="note" className="border-b border-amber-800 bg-amber-950/40 px-4 py-2 text-xs text-amber-200">
              <strong>מצב הדגמה — ללא מודל שפה.</strong>{" "}
              {status.demo_reason && <span dir="auto">{status.demo_reason} </span>}
              התשובות נבנות מכללים קבועים מעל נתוני המעבדה האמיתיים.
            </div>
          )}
          {status?.mode === "llm" && (
            <p role="note" dir="auto" className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-1.5 text-[11px] leading-relaxed text-zinc-400">
              {typeof status.egress_note === "string" && status.egress_note.trim() ? status.egress_note
                : "שים לב: השאלה ונתוני המעבדה ששימשו לתשובה (כמו שמות ציוד, כתובות ניהול, תוויות ושמות בעלים) נשלחים לעיבוד ב־Anthropic. סיסמאות, פרטי התחברות, כתובות דוא״ל וזהות המשתמש אינם נשלחים."}
            </p>
          )}
          {statusError && (
            <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-rose-900 bg-rose-950/30 px-4 py-2 text-xs text-rose-300">
              <span>{notInstalled ? "העוזר אינו מותקן בשרת הזה. נדרש עדכון של גרסת השרת." : `לא ניתן לבדוק את מצב העוזר: ${errorText(statusError)}`}</span>
              <button type="button" className="underline" onClick={loadStatus}>נסה שוב</button>
            </div>
          )}
          {status?.enabled === false && (
            <div role="alert" className="border-b border-amber-800 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">העוזר כבוי בהגדרות השרת.</div>
          )}

          <div role="tablist" aria-label="תצוגות העוזר" onKeyDown={onTabKey} className="flex border-b border-zinc-800 px-2">
            {tabs.map(([id, label]) => (
              <button key={id} ref={el => { tabRefs.current[id] = el; }} type="button" role="tab" id={`${baseId}-tab-${id}`}
                aria-selected={tab === id} aria-controls={`${baseId}-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-3 py-2 text-xs ${tab === id ? "border-nv-400 font-semibold text-nv-300" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}>
                {label}
                {id === "actions" && anyExecuting && <><span aria-hidden="true" className="ms-1 text-amber-300">•</span><span className="sr-only"> (פעולה בביצוע)</span></>}
              </button>
            ))}
          </div>

          {tab === "chat" && (
            <div role="tabpanel" id={`${baseId}-panel-chat`} aria-labelledby={`${baseId}-tab-chat`} className="flex min-h-0 flex-1 flex-col">
              {chip && (
                <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs">
                  <span className="inline-flex min-w-0 items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300">
                    <span className="truncate">בהקשר: {chip.prefix} <bdi className="font-mono text-zinc-100">{chip.name}</bdi></span>
                    <button type="button" onClick={() => setDismissedKey(mergedKey)} aria-label="הסר את ההקשר מהשאלות" title="שאל בלי הקשר"
                      className="ms-1 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">×</button>
                  </span>
                </div>
              )}
              {status?.legacy_shared_history && (
                <p className="border-b border-zinc-800 px-4 py-1.5 text-[11px] text-zinc-500">מצב סיסמה משותפת: היסטוריית השיחות משותפת לכל מי שמשתמש באתר.</p>
              )}

              <div ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="השיחה עם העוזר" aria-busy={!!pending || convLoading}
                className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
                {convLoading && <p role="status" className="flex items-center gap-2 text-sm text-zinc-400"><Spinner />טוען את השיחה…</p>}
                {convError && (
                  <div role="alert" className="rounded border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">
                    השיחה לא נטענה: {errorText(convError)}{" "}
                    <button type="button" className="underline" onClick={() => loadConversation(conversationId)}>נסה שוב</button>
                  </div>
                )}
                {!messages.length && !convLoading && !convError && !pending && (
                  <div className="space-y-3 text-sm text-zinc-400">
                    <p>שאל בעברית על מצב המעבדה: תקלות, ציוד מושפע, קיבולת ותחזוקה. כל תשובה מבוססת על נתוני המערכת ומציינת מקורות וזמני עדכון.</p>
                    <p className="text-xs text-zinc-500">העוזר קורא נתונים בלבד. הוא אינו מפעיל ציוד ואינו שומר משימות בלי אישורך.</p>
                    <div className="flex flex-wrap gap-1.5" aria-label="שאלות לדוגמה">
                      {examples.map(q => (
                        <button key={q} type="button" onClick={() => { setInput(q); inputRef.current?.focus(); }}
                          className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:border-nv-400 hover:text-zinc-100">
                          <bdi>{q}</bdi>
                        </button>
                      ))}
                    </div>
                    {Array.isArray(status?.sources) && status.sources.length > 0 && (
                      <details className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                        <summary className="cursor-pointer text-zinc-300">מקורות הנתונים של העוזר ({status.sources.length})</summary>
                        <ul className="mt-2 space-y-1">
                          {status.sources.map((s, i) => (
                            <li key={`${s?.name}-${i}`} className="flex flex-wrap gap-x-2">
                              <span className={s?.status === "ok" ? "text-emerald-300" : "text-amber-300"}>{sourceStatusLabel(s?.status)}</span>
                              <bdi className="text-zinc-200">{String(s?.name ?? "")}</bdi>
                              {s?.note && <span dir="auto" className="text-zinc-500">{String(s.note)}</span>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}

                {messages.map(m => m.role === "user" ? (
                  <div key={m.id} data-message="" data-role="user" className="flex justify-start">
                    <div className="max-w-[85%] rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-100">
                      <span className="sr-only">השאלה שלך: </span>
                      <span dir="auto" className="whitespace-pre-wrap break-words">{m.text}</span>
                    </div>
                  </div>
                ) : (
                  <article key={m.id} data-message="" data-role="assistant" aria-label="תשובת העוזר" className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                    <AnswerView answer={m.answer} sources={m.sources} mode={m.mode} demoReason={m.demo_reason} messageId={m.id} devices={devices}
                      onOpenLink={openLink} onCreateDraft={(d, key) => setDraft({ draft: d, key })} savedKeys={savedKeys}
                      proposals={(m.proposalIds || []).map(id => actions[id]).filter(Boolean)} actionProps={actionProps} />
                    {(m.created_at || m.elapsed_ms != null) && (
                      <p className="mt-3 text-[10px] text-zinc-600">
                        {m.created_at && <bdi className="font-mono">{formatAsOf(m.created_at)}</bdi>}
                        {m.elapsed_ms != null && <> · נענתה תוך {Math.max(1, Math.round(m.elapsed_ms / 1000))} שנ׳</>}
                      </p>
                    )}
                  </article>
                ))}

                {pending && (
                  <p role="status" className="flex items-center gap-2 text-sm text-zinc-400">
                    <Spinner />קורא את נתוני המעבדה…
                    <span aria-hidden="true" className="font-mono text-[11px] text-zinc-600">{elapsed} שנ׳</span>
                  </p>
                )}
              </div>

              {failed && (
                <div className="border-t border-rose-900 bg-rose-950/30 px-4 py-2 text-sm text-rose-300">
                  <p role="alert">{failureText(failed)}</p>
                  {(isRetryable(failed.err) || failed.err.status === 404) && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <button type="button" className={subtle} disabled={!!pending || rateRemaining > 0} onClick={() => send(failed.question, { retry: true })}>
                        {rateRemaining > 0 ? `נסה שוב (${rateRemaining})` : "נסה שוב"}
                      </button>
                      <button type="button" className="text-xs text-zinc-400 underline" onClick={() => setFailed(null)}>סגירה</button>
                    </div>
                  )}
                </div>
              )}
              {notice && (
                <div role="status" className="flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-300">
                  <span dir="auto">{notice.text}</span>
                  {notice.work && <button type="button" className="text-nv-300 underline" onClick={() => setTab("work")}>הצג משימות עבודה</button>}
                  <button type="button" className="ms-auto text-zinc-500 hover:text-zinc-200" aria-label="סגור הודעה" onClick={() => setNotice(null)}>✕</button>
                </div>
              )}

              <form onSubmit={e => { e.preventDefault(); send(input); }} className="space-y-1.5 border-t border-zinc-800 bg-zinc-900/40 p-3">
                <label htmlFor={inputId} className="sr-only">שאלה לעוזר המעבדה</label>
                <textarea id={inputId} ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={onInputKey} rows={3} dir="auto"
                  disabled={blocked} aria-invalid={over || undefined} aria-describedby={`${hintId} ${counterId}`}
                  placeholder="למשל: למה השרת הזה לא זמין?"
                  className="block w-full resize-none rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-nv-400/60 focus:outline-none disabled:opacity-50" />
                <div className="flex items-center gap-2">
                  <VoiceControls className="min-w-0 flex-1" onTranscript={text => setInput(cur => mergeTranscript(cur, text))} speakText={speakText} disabled={!!pending || blocked} />
                  <span id={counterId} className={`ms-auto font-mono text-[11px] ${over ? "text-rose-400" : "text-zinc-500"}`}>
                    <bdi>{charCountText(input.trim().length, maxChars)}</bdi>{over && <span className="sr-only"> — ההודעה ארוכה מהמותר</span>}
                  </span>
                  {pending
                    ? <button type="button" onClick={stop} className="rounded border border-rose-800 bg-rose-950/40 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-900/50">עצור</button>
                    : <button type="submit" disabled={!canSend} title={rateRemaining > 0 ? rateLimitText(rateRemaining) : undefined}
                        className="rounded bg-nv-400 px-4 py-1.5 text-xs font-bold text-zinc-950 hover:bg-nv-300 disabled:cursor-not-allowed disabled:opacity-40">
                        {rateRemaining > 0 ? `שלח (${rateRemaining})` : "שלח"}
                      </button>}
                </div>
                <p id={hintId} className="text-[11px] text-zinc-600">Enter לשליחה · Shift+Enter לשורה חדשה{over ? ` · מקסימום ${maxChars} תווים` : ""}</p>
              </form>
            </div>
          )}

          {tab === "history" && (
            <div role="tabpanel" id={`${baseId}-panel-history`} aria-labelledby={`${baseId}-tab-history`} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-100">שיחות קודמות</h3>
                <button type="button" className={subtle} onClick={loadHistory} disabled={history.loading}>רענון</button>
              </div>
              {status?.legacy_shared_history && <p className="text-[11px] text-zinc-500">מצב סיסמה משותפת: השיחות משותפות לכל המשתמשים.</p>}
              {history.loading && <p role="status" className="flex items-center gap-2 text-sm text-zinc-400"><Spinner />טוען שיחות…</p>}
              {history.error && (
                <div role="alert" className="rounded border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">
                  {errorText(history.error)} <button type="button" className="underline" onClick={loadHistory}>נסה שוב</button>
                </div>
              )}
              {history.list?.length === 0 && !history.loading && <p className="text-sm text-zinc-500">אין עדיין שיחות שמורות.</p>}
              {history.list?.length > 0 && (
                <ul className="space-y-1.5">
                  {history.list.map(c => (
                    <li key={c.id} className={`flex items-center gap-2 rounded border px-3 py-2 ${c.id === conversationId ? "border-nv-400/50 bg-zinc-900" : "border-zinc-800 bg-zinc-950"}`}>
                      <button type="button" onClick={() => openConversation(c.id)} aria-current={c.id === conversationId ? "true" : undefined}
                        className="min-w-0 flex-1 text-start">
                        <span dir="auto" className="block truncate text-sm text-zinc-100">{c.title}</span>
                        <span className="text-[11px] text-zinc-500">
                          <bdi className="font-mono">{formatAsOf(c.updated_at)}</bdi>{c.message_count != null ? ` · ${c.message_count} הודעות` : ""}
                        </span>
                      </button>
                      {confirmDelete === c.id ? (
                        <span className="flex items-center gap-1.5 text-xs">
                          <span className="text-zinc-300">למחוק?</span>
                          <button type="button" autoFocus onClick={() => deleteConversation(c.id)} className="rounded bg-rose-700 px-2 py-1 font-semibold text-white hover:bg-rose-600">מחק</button>
                          <button type="button" onClick={() => setConfirmDelete(null)} className={subtle}>ביטול</button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setConfirmDelete(c.id)} aria-label={`מחק את השיחה: ${c.title}`} className="text-xs text-zinc-500 hover:text-rose-300">מחק</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === "work" && (
            <div role="tabpanel" id={`${baseId}-panel-work`} aria-labelledby={`${baseId}-tab-work`} className="min-h-0 flex-1 overflow-y-auto p-4">
              <WorkItemsList refreshKey={workVersion} />
            </div>
          )}

          {tab === "actions" && actionsTab && (
            <div role="tabpanel" id={`${baseId}-panel-actions`} aria-labelledby={`${baseId}-tab-actions`} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {actionBlock && <p role="note" className="rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">{actionBlock}</p>}
              {tabCards.some(id => actions[id]) && (
                <section aria-label="הצעה נבחרת" className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-zinc-100">הצעה נבחרת</h3>
                    <button type="button" className={subtle} onClick={() => setTabCards([])}>הסתר</button>
                  </div>
                  <ul className="space-y-2">
                    {tabCards.map(id => actions[id] && <li key={id}><ActionProposalCard proposal={actions[id]} devices={devices} {...actionProps} /></li>)}
                  </ul>
                </section>
              )}
              <ActionHistory devices={devices} onSelect={selectFromHistory} onRestore={restoreAction} onOpenConsole={openConsoleEntry} refreshKey={actionsVersion} />
            </div>
          )}
        </aside>
      )}

      {draft && (
        <DraftEditor key={draft.key} draft={draft.draft} conversationId={conversationId || undefined}
          onSaved={item => {   // called when the user closes the dialog after a successful save
            setDraft(null);
            setSavedKeys(keys => ({ ...keys, [draft.key]: item || true }));
            setWorkVersion(v => v + 1);
            setNotice({ text: `המשימה "${item?.title || draft.draft.title}" נשמרה.`, work: true });
          }}
          onCancel={() => setDraft(null)} />
      )}
    </>
  );
}
