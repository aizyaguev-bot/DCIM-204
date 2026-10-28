export const SEEN_VERSION_KEY = "dcim.seenVersion";

export function splitSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) { current = { title: heading[1].trim(), body: [] }; sections.push(current); }
    else if (current && line.trim() !== "---") current.body.push(line);
  }
  return sections.map(s => ({ title: s.title, body: s.body.join("\n").trim() }));
}

export function versionOf(title) {
  return (/^(v\d+(?:\.\d+)*)\b/.exec(String(title || "")) || [])[1] || null;
}

// Changelog card heading: the version (or "Unreleased") and the rest of the title.
export function sectionHeading(title) {
  const text = String(title || "").trim();
  const version = versionOf(text);
  const unreleased = !version && /^unreleased\b/i.test(text);
  const label = version || (unreleased ? "Unreleased" : text);
  const detail = version || unreleased ? text.slice(label.length).replace(/^[\s—–-]+/, "") : "";
  return { label, detail, unreleased };
}

// Sections newer than the version this browser last saw. Unknown or missing
// "seen" versions show only the newest release (and the Unreleased notes above it).
export function releaseNotesSince(text, seen, current, max = 6) {
  if (!current || seen === current) return [];
  const sections = splitSections(text);
  const known = seen && sections.some(s => versionOf(s.title) === seen) ? seen : null;
  const notes = [];
  for (const section of sections) {
    const version = versionOf(section.title);
    if (known && version === known) break;
    if (!known && version && version !== current && notes.length) break;
    notes.push(section);
    if (notes.length >= max) break;
  }
  return notes;
}
