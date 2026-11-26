import { Fragment } from "react";
import { bidiSegments } from "../../api/assistant.js";
import {
  changeRows, excludedGroups, groupTargets, isDataKind, keptCount, movedPositions, outletsText, positionRows, unplacedLines,
} from "../../api/assistantActions.js";

// What a proposal will switch and what it leaves alone, exactly as the server computed it (proposal.impact).
// Every device, PDU and outlet name is plain text in <bdi>; each row always shows the PDU name and the outlet number
// (SEC-ACT-17). `compact` is the card view; the full view is used in the confirm dialog.
// Location changes (server_swap / server_move / server_clear) show the move-server dry run instead: one
// "device · port: before → after" row per label, the rack positions, and who is left without a location.

// "before → after" as one left-to-right island (the names are Latin), read aloud as "מ־before ל־after".
export function DiffValue({ before, after }) {
  return (
    <span dir="ltr" className="inline-flex flex-wrap items-baseline gap-x-1 font-mono">
      <span className="sr-only" lang="he">מ־</span>
      <bdi className="break-all text-zinc-400">{before}</bdi>
      <span aria-hidden="true" className="text-zinc-500">→</span>
      <span className="sr-only" lang="he">ל־</span>
      <bdi className="break-all text-zinc-100">{after}</bdi>
    </span>
  );
}

// Hebrew text with the Latin server names isolated (a local copy of AnswerView's Bidi: no import cycle).
function Isolated({ text }) {
  return bidiSegments(text).map((seg, i) => (seg.ltr ? <bdi key={i} className="font-mono">{seg.text}</bdi> : <Fragment key={i}>{seg.text}</Fragment>));
}

// The applied/proposed list; also used by ActionProgress for the result of a location change. Positions that stay
// the same are not listed; `warnings` (the server's warnings_he) supply the fuller "left without a location" text.
export function DataChangeList({ changes, positions, unplaced, warnings = [], past = false, scroll = false }) {
  const rows = changeRows(changes);
  const spots = positionRows(positions);
  const left = unplacedLines(unplaced, warnings, past);
  const box = scroll && rows.length + spots.length > 8 ? "max-h-56 overflow-y-auto pe-1" : "";
  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <ul aria-label="תוויות שקעים ופורטים" className={`divide-y divide-zinc-800/60 ${box}`}>
          {rows.map(r => (
            <li key={r.key} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5 text-xs">
              <span className="text-zinc-300"><bdi className="font-mono text-zinc-200">{r.device}</bdi> · {r.word} <bdi>{r.port}</bdi>:</span>
              <DiffValue before={r.before} after={r.after} />
            </li>
          ))}
        </ul>
      )}
      {spots.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-zinc-400">מיקום בארון</p>
          <ul aria-label="מיקום בארון" className="divide-y divide-zinc-800/60">
            {spots.map(s => (
              <li key={s.key} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5 text-xs">
                <span className="text-zinc-300"><bdi className="font-mono text-zinc-200">{s.server}</bdi>:</span>
                <DiffValue before={s.before} after={s.after} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {left.length > 0 && (
        <ul className="space-y-0.5 rounded border border-amber-800/70 bg-amber-950/30 px-2 py-1 text-xs text-amber-200">
          {left.map(line => (
            <li key={line.name}><span aria-hidden="true">⚠ </span><Isolated text={line.text} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DataImpact({ proposal, compact }) {
  const { changes, positions, unplaced, warnings_he: warnings } = proposal.impact;
  const pending = proposal.status === "pending";
  const moved = movedPositions(positions).length;
  const empty = !changes.length && !moved;
  // server_clear keeps the rack position; said here unless the server's own warning already says it.
  const keptNote = proposal.kind === "server_clear" && !moved && !warnings.some(w => w.includes("המיקום בארון"));
  return (
    <div className="space-y-2">
      <p className={compact ? "text-[11px] text-zinc-400" : "text-xs font-semibold text-zinc-300"}>
        {pending ? "מה ישתנה" : "השינויים שהוצעו"} <span className="font-normal text-zinc-400">(החשמל לא ישתנה)</span>
      </p>
      {empty ? <p className="text-xs text-zinc-400">אין שינויים ברשימה.</p>
        : <DataChangeList changes={changes} positions={positions} unplaced={unplaced} warnings={warnings} scroll />}
      {keptNote && <p className="text-[11px] text-zinc-400">המיקום בארון לא ישתנה.</p>}
    </div>
  );
}

const STATE_TEXT = { on: "דולק עכשיו", off: "כבוי עכשיו", cycling: "באתחול", unknown: "מצב לא ידוע" };
// After the proposal left "pending" the stored state is history, not the live state.
const PAST_STATE_TEXT = { on: "היה דולק בעת ההצעה", off: "היה כבוי בעת ההצעה", cycling: "היה באתחול בעת ההצעה", unknown: "מצב לא ידוע בעת ההצעה" };
const CAPTION = {
  off: "מה ייכבה", on: "מה יודלק", cycle: "מה יאותחל (ניתוק והחזרה)", maintenance_off: "מה ייכבה (מעבר לתחזוקה)",
  maintenance_on: "מה יודלק (חזרה מתחזוקה)",
};
const KEPT_HEADING = { off: "לא ייכבו", maintenance_off: "לא ייכבו", cycle: "לא יאותחלו", on: "לא יודלקו", maintenance_on: "לא יודלקו" };
const ALWAYS_LISTED = ["unreachable", "unknown_state"];

function TargetRow({ t, showPdu = true, past = false }) {
  const states = past ? PAST_STATE_TEXT : STATE_TEXT;
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5 text-xs">
      {showPdu && <><bdi className="font-mono text-zinc-200">{t.pdu_name}</bdi><span aria-hidden="true" className="text-zinc-500">·</span></>}
      <span className="text-zinc-300">שקע {t.outlet}</span>
      {t.label && <><span aria-hidden="true" className="text-zinc-500">·</span><bdi className="font-mono break-all text-zinc-100">{t.label}</bdi></>}
      {t.server && t.server !== t.label && <span className="text-zinc-400">(שרת <bdi className="font-mono">{t.server}</bdi>)</span>}
      <span className={t.state === "unknown" ? "text-amber-300" : "text-zinc-400"}>— {states[t.state] || states.unknown}</span>
    </li>
  );
}

function ExcludedRow({ e, text }) {
  return (
    <li className="py-0.5 text-xs">
      <bdi className="font-mono text-zinc-200">{e.pdu_name}</bdi>
      <span className="text-zinc-300"> · {e.outlet !== null ? `שקע ${e.outlet}` : "כל ה-PDU"}</span>
      {e.label && <> · <bdi className="font-mono break-all text-zinc-100">{e.label}</bdi></>}
      <span className="block text-amber-200/90 sm:inline"> — {text}</span>
    </li>
  );
}

function GroupedTargets({ targets, open, past }) {
  return (
    <div className="space-y-2">
      {groupTargets(targets).map(rack => (
        <div key={rack.rack || "-"}>
          {rack.rack && <p className="text-[11px] font-semibold text-zinc-400">ארון <bdi className="font-mono">{rack.rack}</bdi></p>}
          {rack.pdus.map(pdu => (
            <details key={pdu.pdu_id} open={open} className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1">
              <summary className="cursor-pointer text-xs text-zinc-200">
                <bdi className="font-mono">{pdu.pdu_name}</bdi> · {outletsText(pdu.outlets.length)}
              </summary>
              <ul className="mt-1 divide-y divide-zinc-800/60">
                {pdu.outlets.map(t => <TargetRow key={`${t.pdu_id}:${t.outlet}`} t={t} showPdu={false} past={past} />)}
              </ul>
            </details>
          ))}
        </div>
      ))}
    </div>
  );
}

function ExcludedList({ groups, only }) {
  const shown = only ? groups.filter(g => only.includes(g.reason)) : groups;
  if (!shown.length) return null;
  return (
    <ul className="space-y-0.5">
      {shown.flatMap(g => g.items.map((e, i) => <ExcludedRow key={`${g.reason}:${e.pdu_id}:${e.outlet ?? "pdu"}:${i}`} e={e} text={g.row} />))}
    </ul>
  );
}

export default function ActionImpact({ proposal, compact = false }) {
  if (!proposal) return null;
  if (isDataKind(proposal)) return <DataImpact proposal={proposal} compact={compact} />;
  const { impact, sw } = proposal;
  const { counts, targets, excluded, servers } = impact;
  const groups = excludedGroups(excluded);
  const kept = keptCount(excluded);
  const tone = sw === "on" || sw === "maintenance_on" ? "text-nv-300" : "text-rose-300";
  const past = proposal.status !== "pending";

  if (sw === "none") {
    return servers.length ? (
      <p className="text-xs text-zinc-300">שרת: {servers.map((s, i) => <bdi key={s} className="font-mono">{i ? ", " : ""}{s}</bdi>)}</p>
    ) : null;
  }

  const stats = (
    <dl className="grid grid-cols-3 gap-1.5 text-center">
      {[["שרתים", counts.servers], ["PDU", counts.pdus], ["שקעים", counts.outlets]].map(([label, n]) => (
        <div key={label} className="flex flex-col-reverse rounded border border-zinc-800 bg-zinc-950 px-1 py-1">
          <dt className="text-[11px] text-zinc-400">{label}</dt>
          <dd className={`text-lg font-bold leading-6 ${n ? tone : "text-zinc-400"}`}>{n}</dd>
        </div>
      ))}
    </dl>
  );

  const keptBox = groups.length > 0 && (
    <div className="space-y-1 rounded border border-amber-800/70 bg-amber-950/30 p-2">
      {kept > 0 && <p className="text-xs font-semibold text-amber-200">{KEPT_HEADING[sw] || "לא ייכללו"}: {kept === 1 ? "רכיב אחד" : `${kept} רכיבים`}</p>}
      <ul className="flex flex-wrap gap-1" aria-label="סיבות">
        {groups.map(g => (
          <li key={g.reason} className={`rounded border px-1.5 py-0.5 text-[11px] ${g.tone === "zinc" ? "border-zinc-700 text-zinc-400" : "border-amber-700 text-amber-200"}`}>
            {g.short} {g.count}
          </li>
        ))}
      </ul>
      {compact ? <ExcludedList groups={groups} only={ALWAYS_LISTED} /> : (
        <div className="max-h-48 overflow-y-auto"><ExcludedList groups={groups.filter(g => g.tone !== "zinc")} /></div>
      )}
    </div>
  );

  if (!compact) {
    return (
      <div className="space-y-3">
        <p className="text-xs font-semibold text-zinc-300">{CAPTION[sw] || "מה ישתנה"}</p>
        {stats}
        {targets.length > 0 && <div className="max-h-64 overflow-y-auto pe-1"><GroupedTargets targets={targets} open past={past} /></div>}
        {keptBox}
      </div>
    );
  }

  const small = targets.length <= 4;
  const shownServers = servers.slice(0, 4);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-zinc-400">{CAPTION[sw] || "מה ישתנה"}</p>
      {stats}
      {small ? (
        targets.length > 0 && <ul className="divide-y divide-zinc-800/60">{targets.map(t => <TargetRow key={`${t.pdu_id}:${t.outlet}`} t={t} past={past} />)}</ul>
      ) : (
        <>
          {shownServers.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="שרתים מושפעים">
              {shownServers.map(s => <li key={s} className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-200"><bdi className="font-mono">{s}</bdi></li>)}
              {servers.length > shownServers.length && <li className="px-1 py-0.5 text-[11px] text-zinc-400">ועוד {servers.length - shownServers.length}</li>}
            </ul>
          )}
          <details className="rounded border border-zinc-800 px-2 py-1">
            <summary className="cursor-pointer text-xs text-zinc-300">רשימה מלאה ({outletsText(targets.length)})</summary>
            <div className="mt-1 max-h-48 overflow-y-auto pe-1">
              <GroupedTargets targets={targets} open={false} past={past} />
              {groups.some(g => g.tone !== "zinc" && !ALWAYS_LISTED.includes(g.reason)) && (
                <div className="mt-2">
                  <p className="text-[11px] font-semibold text-amber-200">לא ייכללו</p>
                  <ExcludedList groups={groups.filter(g => g.tone !== "zinc" && !ALWAYS_LISTED.includes(g.reason))} />
                </div>
              )}
            </div>
          </details>
        </>
      )}
      {keptBox}
    </div>
  );
}
