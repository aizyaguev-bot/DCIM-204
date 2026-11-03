"""Pure host rewrite of inst.repo / inst.ks URLs on the linux/linuxefi line of a GRUB entry.

Only the host of each key's http(s) URL changes; every byte outside the replaced spans stays identical.
"""
import hashlib
import re
from typing import NamedTuple

DEFAULT_KEYS = ("inst.repo", "inst.ks")
_LINUX = re.compile(r"[ \t]*(?:linux|linuxefi)(?=[ \t]|$)")
_URL = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)(.*)", re.S)
_OLD_HOST = re.compile(r"[0-9A-Za-z][0-9A-Za-z.-]*")
_NEW_HOST = re.compile(r"[0-9A-Za-z.:-]+")


class RewriteError(ValueError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


class RewriteResult(NamedTuple):
    text: str
    changes: list[dict]
    warnings: list[dict]


class _Value(NamedTuple):
    key: str
    start: int          # value start in the joined logical line (inside quotes)
    end: int
    value: str


def _logical_lines(text: str) -> list[tuple[str, list[int]]]:
    """Joins `\\`-newline continuations; each joined char maps back to its offset in text."""
    result, joined, index = [], [], []
    pos = 0
    for raw in re.findall(r"[^\n]*\n|[^\n]+$", text):
        body = raw[:-1] if raw.endswith("\n") else raw
        body = body[:-1] if body.endswith("\r") else body
        continued = body.endswith("\\")
        content = body[:-1] if continued else body
        joined.append(content)
        index.extend(range(pos, pos + len(content)))
        pos += len(raw)
        if not continued:
            result.append(("".join(joined), index))
            joined, index = [], []
    if joined:
        result.append(("".join(joined), index))
    return result


def _tokens(line: str):
    """Whitespace-separated tokens; quotes group whitespace."""
    i, n = 0, len(line)
    while i < n:
        while i < n and line[i] in " \t":
            i += 1
        if i >= n:
            break
        start, quote = i, None
        while i < n and (quote or line[i] not in " \t"):
            if quote and line[i] == quote:
                quote = None
            elif not quote and line[i] in "\"'":
                quote = line[i]
            i += 1
        yield start, i


def _linux_line(text: str) -> tuple[str, list[int]]:
    lines = [entry for entry in _logical_lines(text) if _LINUX.match(entry[0])]
    if not lines:
        raise RewriteError("missing_linux_line", "No linux/linuxefi line found")
    if len(lines) > 1:
        raise RewriteError("ambiguous_linux_line", "More than one linux/linuxefi line found")
    return lines[0]


def _values(line: str, keys) -> dict[str, list[_Value]]:
    found = {key: [] for key in keys}
    for start, end in _tokens(line):
        token = line[start:end]
        name, sep, _ = token.partition("=")
        if not sep or name not in found:
            continue
        vstart, vend = start + len(name) + 1, end
        if vstart < vend and line[vstart] in "\"'":
            quote = line[vstart]
            if vend - vstart < 2 or line[vend - 1] != quote:
                raise RewriteError("unbalanced_quote", f"{name} has an unbalanced quote")
            vstart, vend = vstart + 1, vend - 1
        found[name].append(_Value(name, vstart, vend, line[vstart:vend]))
    return found


def _host_span(item: _Value) -> tuple[int, int, str]:
    match = _URL.fullmatch(item.value)
    if not match or match[1].lower() not in ("http", "https"):
        raise RewriteError("unsupported_scheme", f"{item.key} is not an http(s) URL")
    authority = match[2]
    if "@" in authority:
        raise RewriteError("credentials_in_url", f"{item.key} URL contains credentials")
    host = authority[:authority.index("]") + 1] if authority.startswith("[") and "]" in authority else authority.split(":", 1)[0]
    if not host:
        raise RewriteError("unsupported_scheme", f"{item.key} URL has no host")
    start = item.start + len(match[1]) + 3
    return start, start + len(host), host


def _scan(text: str, keys) -> tuple[str, list[int], dict[str, tuple[int, int, str]]]:
    line, index = _linux_line(text)
    hosts = {}
    for key, items in _values(line, keys).items():
        if not items:
            raise RewriteError("missing_key", f"{key} not found on the linux line")
        if len(items) > 1:
            raise RewriteError("ambiguous_key", f"{key} appears {len(items)} times on the linux line")
        hosts[key] = _host_span(items[0])
    return line, index, hosts


def key_hosts(text: str, keys=DEFAULT_KEYS) -> dict[str, str]:
    """Host of each key's URL on the linux line; same validation as the rewrite."""
    return {key: host for key, (_, _, host) in _scan(text, keys)[2].items()}


def _check_hosts(old_host: str, new_host: str):
    if not _OLD_HOST.fullmatch(old_host or ""):
        raise ValueError("Invalid old repository host")
    if not _NEW_HOST.fullmatch(new_host or ""):
        raise ValueError("Invalid new repository host")
    if old_host.casefold() == new_host.casefold():
        raise ValueError("Old and new repository hosts are identical")


def rewrite_install_urls(cmdline: str, old_host: str, new_host: str, keys=DEFAULT_KEYS) -> RewriteResult:
    _check_hosts(old_host, new_host)
    line, index, hosts = _scan(cmdline, keys)
    changes, warnings, spans = [], [], []
    for key, (start, end, host) in hosts.items():
        if host.casefold() == old_host.casefold():
            spans.append((start, end))
            ostart, oend = index[start], index[end - 1] + 1
            changes.append({"key": key, "start": ostart, "end": oend, "before": cmdline[ostart:oend], "after": new_host})
        elif host.casefold() != new_host.casefold():
            warnings.append({"code": "unexpected_host", "key": key, "detail": f"{key} points to another host (unchanged)"})
    label = re.compile(r"(?<![0-9A-Za-z.-])" + re.escape(old_host) + r"(?![0-9A-Za-z-]|\.[0-9A-Za-z])", re.I)
    tokens = list(_tokens(line))
    for match in label.finditer(line):
        if any(s <= match.start() < e for s, e in spans):
            continue
        token = next((line[s:e] for s, e in tokens if s <= match.start() < e), "")
        name = token.partition("=")[0] if "=" in token else token[:40]
        warnings.append({"code": "other_occurrence", "key": name,
                         "detail": f"{old_host} also appears in {name or 'the linux line'} (unchanged)"})
    text = cmdline
    for change in sorted(changes, key=lambda c: c["start"], reverse=True):
        text = text[:change["start"]] + new_host + text[change["end"]:]
    changes.sort(key=lambda c: c["start"])
    return RewriteResult(text, changes, warnings)


def rewrite_hash(before: str, after: str) -> str:
    return hashlib.sha256(f"{before}\0{after}".encode()).hexdigest()[:32]
