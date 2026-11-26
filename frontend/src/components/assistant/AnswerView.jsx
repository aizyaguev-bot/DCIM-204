import { Fragment } from "react";
import ActionProposalCard from "./ActionProposalCard.jsx";
import {
  answerModeBadge, bidiSegments, draftFromRecommendation, entityLink, formatAge, formatAsOf, priorityLabel, sourceStatusLabel,
} from "../../api/assistant";

// Renders one assistant answer (contracts.ANSWER_SCHEMA after normalizeAnswer) as React elements only.
// Every string comes from the server or the model and is treated as text: no HTML, no markdown, no URLs.

const STATUS_TONE = {
  ok: ["bg-emerald-400", "text-emerald-300", "border-zinc-800"],
  stale: ["bg-amber-400", "text-amber-300", "border-amber-800/70"],
  missing: ["bg-rose-400", "text-rose-300", "border-rose-900/70"],
  unavailable: ["bg-rose-400", "text-rose-300", "border-rose-900/70"],
  disabled: ["bg-zinc-500", "text-zinc-400", "border-zinc-700"],
  unknown: ["bg-zinc-500", "text-zinc-400", "border-zinc-700"],
};
const PRIORITY_TONE = {
  high: "border-rose-800 bg-rose-950/40 text-rose-300",
  medium: "border-amber-800 bg-amber-950/30 text-amber-200",
  low: "border-zinc-700 bg-zinc-800 text-zinc-300",
};
const KIND_LABELS = { server: "שרת", pdu: "PDU", kvm: "KVM", rack: "ארון", item: "פריט", incident: "תקלה", maintenance: "תחזוקה", work_item: "משימה" };

export const sourceDomId = (messageId, index) => `assistant-src-${String(messageId).replace(/[^A-Za-z0-9_-]/g, "_")}-${index}`;

// Hebrew text with Latin ids/IPs/names isolated in <bdi>.
export function Bidi({ text, mono = false }) {
  // A short id stays on one line ("Rack-01" never splits at the hyphen); a long single token may break anywhere;
  // an English phrase wraps at its spaces as usual.
  const wrap = t => (/\s/.test(t) ? "" : t.length <= 24 ? "whitespace-nowrap" : "break-all");
  return bidiSegments(text).map((seg, i) => seg.ltr
    ? <bdi key={i} className={`${mono ? "font-mono " : ""}${wrap(seg.text)}`.trim() || undefined}>{seg.text}</bdi>
    : <Fragment key={i}>{seg.text}</Fragment>);
}

function SectionTitle({ children, id }) {
  return <h4 id={id} className="text-xs font-semibold text-zinc-400 mb-1.5">{children}</h4>;
}

function SourceChips({ ids, sourceIndex, messageId }) {
  if (!ids?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle ms-1.5">
      {ids.map(id => {
        const index = sourceIndex.byId.get(id);
        const source = index === undefined ? null : sourceIndex.list[index];
        const [dot] = STATUS_TONE[source?.status] || STATUS_TONE.unknown;
        const label = source ? source.name : id;
        const title = source ? `${sourceStatusLabel(source.status)}${source.ref ? ` · ${source.ref}` : ""}${source.note ? ` · ${source.note}` : ""}` : "מקור שלא הוחזר בתשובה";
        const focusSource = () => {
          const el = document.getElementById(sourceDomId(messageId, index));
          if (!el) return;
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
          el.focus({ preventScroll: true });
        };
        return source
          ? <button key={id} type="button" onClick={focusSource} title={title}
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] leading-4 text-zinc-300 hover:border-nv-400 hover:text-zinc-100">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
              <span className="sr-only">מקור: </span><bdi>{label}</bdi>
              {source.status !== "ok" && <span className="text-amber-300">({sourceStatusLabel(source.status)})</span>}
            </button>
          : <span key={id} title={title} className="inline-flex items-center rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] leading-4 text-zinc-500">
              <bdi className="font-mono">{id}</bdi>
            </span>;
      })}
    </span>
  );
}

function EntityChip({ entity, devices, onOpenLink }) {
  const link = entityLink(entity, devices);
  const kind = KIND_LABELS[entity.kind] || entity.kind;
  const body = <><span className="text-zinc-500">{kind}</span> <bdi className="font-mono">{entity.label || entity.id}</bdi></>;
  if (!link) return <span className="inline-flex items-center gap-1 rounded border border-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{body}</span>;
  const where = link.detail ? "פתח את הרשומה" : link.rack ? "פתח את הארון" : "פתח את העמוד";
  return (
    <button type="button" onClick={() => onOpenLink?.(link)} title={where}
      className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-nv-300 hover:border-nv-400 hover:bg-zinc-800">
      {body}<span aria-hidden="true">‹</span><span className="sr-only">{` — ${where}`}</span>
    </button>
  );
}

function EntityChips({ refs, devices, onOpenLink }) {
  if (!refs?.length) return null;
  return <div className="flex flex-wrap gap-1.5">{refs.map((r, i) => <EntityChip key={`${r.kind}:${r.id}:${i}`} entity={r} devices={devices} onOpenLink={onOpenLink} />)}</div>;
}

function Recommendation({ rec, index, messageId, drafts, sourceIndex, devices, onOpenLink, onCreateDraft, saved }) {
  const key = `${messageId}:rec:${index}`;
  const headingId = `${sourceDomId(messageId, "rec")}-${index}`;
  return (
    <li aria-labelledby={headingId} className="rounded border border-zinc-800 bg-zinc-950 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">הצעה</span>
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${PRIORITY_TONE[rec.priority] || PRIORITY_TONE.medium}`}>עדיפות {priorityLabel(rec.priority)}</span>
        {saved && <span role="status" className="rounded border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-[10px] text-emerald-300">נשמרה כמשימה</span>}
      </div>
      <h5 id={headingId} className="text-sm font-semibold text-zinc-100"><Bidi text={rec.title || rec.problem} /></h5>
      <dl className="space-y-1.5 text-sm">
        {rec.problem && <div><dt className="text-xs text-zinc-500">הבעיה</dt><dd className="text-zinc-300"><Bidi text={rec.problem} /></dd></div>}
        {rec.evidence && <div><dt className="text-xs text-zinc-500">נתונים תומכים</dt><dd className="text-zinc-300"><Bidi text={rec.evidence} /><SourceChips ids={rec.source_ids} sourceIndex={sourceIndex} messageId={messageId} /></dd></div>}
        {!rec.evidence && rec.source_ids.length > 0 && <div><dt className="text-xs text-zinc-500">מקורות</dt><dd><SourceChips ids={rec.source_ids} sourceIndex={sourceIndex} messageId={messageId} /></dd></div>}
        {rec.next_step && <div><dt className="text-xs text-zinc-500">הצעד הבא</dt><dd className="text-zinc-200"><Bidi text={rec.next_step} /></dd></div>}
        {rec.missing_info.length > 0 && <div><dt className="text-xs text-amber-300">מידע חסר להחלטה</dt>
          <dd><ul className="list-disc ps-5 text-amber-200/90">{rec.missing_info.map((m, i) => <li key={i}><Bidi text={m} /></li>)}</ul></dd></div>}
      </dl>
      <EntityChips refs={rec.entity_refs} devices={devices} onOpenLink={onOpenLink} />
      {onCreateDraft && (
        <button type="button" onClick={() => onCreateDraft(draftFromRecommendation(rec, drafts), key)}
          className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:border-nv-400 hover:bg-zinc-800">
          {saved ? "צור טיוטה נוספת" : "צור טיוטת עבודה"}
        </button>
      )}
    </li>
  );
}

// proposals: action proposals created for this answer (public JSON after normalizeProposal, kept current by the
// panel); actionProps: the handlers and context every ActionProposalCard gets (see ActionProposalCard).
export default function AnswerView({ answer, sources = [], mode, demoReason, messageId, devices, onOpenLink, onCreateDraft, savedKeys = {},
  proposals = [], actionProps = {} }) {
  const sourceIndex = { byId: new Map(sources.map((s, i) => [s.id, i])), list: sources };
  const recTitles = new Set(answer.recommendations.map(r => r.title.trim()).filter(Boolean));
  const extraDrafts = answer.work_item_drafts.map((d, i) => ({ d, i })).filter(({ d }) => !recTitles.has(d.title.trim()));
  const weakSources = sources.filter(s => s.status !== "ok").length;
  const badge = answerModeBadge(mode, demoReason);   // per answer: /status may be older than the mode that answered

  return (
    <div className="space-y-4 text-sm leading-relaxed text-zinc-200">
      {badge?.tone === "demo" && <p data-answer-mode="demo" className="rounded border border-amber-800 bg-amber-950/40 px-2 py-0.5 text-[11px] text-amber-200">
        <strong>{badge.text}</strong>{badge.reason ? <span dir="auto"> · {badge.reason}</span> : null}</p>}
      {badge?.tone === "llm" && <p data-answer-mode="llm" className="rounded border border-nv-400/40 bg-nv-400/10 px-2 py-0.5 text-[11px] text-nv-300">
        <Bidi text={badge.text} /></p>}
      {answer.summary && <p className="whitespace-pre-line text-zinc-100"><Bidi text={answer.summary} /></p>}

      {proposals.length > 0 && <section aria-labelledby={`${sourceDomId(messageId, "acts")}-h`}>
        <SectionTitle id={`${sourceDomId(messageId, "acts")}-h`}>פעולות מוצעות</SectionTitle>
        <p className="mb-1.5 text-[11px] text-zinc-400">כל פעולה רצה רק אחרי אישור בכרטיס שלה. הכרטיס מציג את ההשפעה כפי שהשרת חישב אותה.</p>
        <ul className="space-y-2">
          {proposals.map(p => <li key={p.id}><ActionProposalCard proposal={p} devices={devices} {...actionProps} /></li>)}
        </ul>
      </section>}

      {answer.facts.length > 0 && <section>
        <SectionTitle>עובדות</SectionTitle>
        <ul className="list-disc ps-5 space-y-1">
          {answer.facts.map((f, i) => <li key={i}><Bidi text={f.text} /><SourceChips ids={f.source_ids} sourceIndex={sourceIndex} messageId={messageId} />
            {!f.source_ids.length && <span className="ms-1.5 text-[10px] text-amber-300">(ללא מקור)</span>}</li>)}
        </ul>
      </section>}

      {answer.hypotheses.length > 0 && <section>
        <SectionTitle>השערות</SectionTitle>
        <p className="mb-1.5 text-[11px] text-zinc-500">אלה סיבות אפשריות, לא עובדות. יש לאמת לפני פעולה.</p>
        <ul className="space-y-2">
          {answer.hypotheses.map((h, i) => <li key={i} className="rounded border border-zinc-800 border-s-2 border-s-amber-700 bg-zinc-950 p-2.5 space-y-1">
            <div className="text-zinc-100"><Bidi text={h.text} /><SourceChips ids={h.source_ids} sourceIndex={sourceIndex} messageId={messageId} /></div>
            {h.support.length > 0 && <div><div className="text-xs text-zinc-500">מה תומך</div><ul className="list-disc ps-5 text-zinc-300">{h.support.map((s, j) => <li key={j}><Bidi text={s} /></li>)}</ul></div>}
            {h.verify && <div><div className="text-xs text-zinc-500">איך לאמת</div><div className="text-zinc-300"><Bidi text={h.verify} /></div></div>}
          </li>)}
        </ul>
      </section>}

      {answer.checks.length > 0 && <section>
        <SectionTitle>מה לבדוק קודם</SectionTitle>
        <ol className="list-decimal ps-5 space-y-1 marker:text-nv-300">{answer.checks.map((c, i) => <li key={i}><Bidi text={c} /></li>)}</ol>
      </section>}

      {answer.recommendations.length > 0 && <section>
        <SectionTitle>המלצות</SectionTitle>
        <ul className="space-y-2">
          {answer.recommendations.map((rec, i) => <Recommendation key={i} rec={rec} index={i} messageId={messageId} drafts={answer.work_item_drafts}
            sourceIndex={sourceIndex} devices={devices} onOpenLink={onOpenLink} onCreateDraft={onCreateDraft} saved={!!savedKeys[`${messageId}:rec:${i}`]} />)}
        </ul>
      </section>}

      {extraDrafts.length > 0 && <section>
        <SectionTitle>טיוטות עבודה מוצעות</SectionTitle>
        <ul className="space-y-1.5">
          {extraDrafts.map(({ d, i }) => {
            const key = `${messageId}:draft:${i}`;
            return <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
              <span className="text-zinc-200"><Bidi text={d.title} /> <span className="text-[11px] text-zinc-500">· עדיפות {priorityLabel(d.priority)}</span>
                {savedKeys[key] && <span className="ms-2 text-[11px] text-emerald-300">נשמרה כמשימה</span>}</span>
              {onCreateDraft && <button type="button" onClick={() => onCreateDraft(d, key)}
                className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-100 hover:border-nv-400 hover:bg-zinc-800">פתח טיוטה לעריכה</button>}
            </li>;
          })}
        </ul>
      </section>}

      {answer.missing_data.length > 0 && <section className="rounded border border-amber-800 bg-amber-950/30 p-3">
        <SectionTitle><span className="text-amber-300">מידע חסר</span></SectionTitle>
        <ul className="list-disc ps-5 space-y-1 text-amber-200">{answer.missing_data.map((m, i) => <li key={i}><Bidi text={m} /></li>)}</ul>
      </section>}

      {answer.entity_refs.length > 0 && <section>
        <SectionTitle>רשומות באתר</SectionTitle>
        <EntityChips refs={answer.entity_refs} devices={devices} onOpenLink={onOpenLink} />
      </section>}

      <section>
        <SectionTitle>מקורות{weakSources ? <span className="ms-1 font-normal text-amber-300">({weakSources} לא עדכניים או חסרים)</span> : null}</SectionTitle>
        {sources.length === 0
          ? <p className="text-xs text-zinc-500">לא צורפו מקורות לתשובה זו. אין לראות בה מידע מאומת.</p>
          : <ul className="space-y-1">
              {sources.map((s, i) => {
                const [dot, text, border] = STATUS_TONE[s.status] || STATUS_TONE.unknown;
                return <li key={s.id} id={sourceDomId(messageId, i)} tabIndex={-1}
                  className={`rounded border ${border} bg-zinc-950 px-2.5 py-1.5 text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-nv-300`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={`inline-flex items-center gap-1 font-semibold ${text}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />{sourceStatusLabel(s.status)}</span>
                    <bdi className="text-zinc-200">{s.name}</bdi>
                    {s.ref && <bdi className="font-mono text-zinc-400">{s.ref}</bdi>}
                  </div>
                  <div className="text-zinc-500">
                    {s.as_of ? <>נכון ל־<bdi className="font-mono">{formatAsOf(s.as_of)}</bdi> · </> : null}{formatAge(s.age_s)}
                  </div>
                  {s.note && <div dir="auto" className="text-zinc-400">{s.note}</div>}
                </li>;
              })}
            </ul>}
      </section>
    </div>
  );
}
