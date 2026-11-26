"""Recognise console screens from text (boot menu, GRUB menu/editor, installer) without assuming option order."""
import hashlib
import re
from typing import NamedTuple

from .screen import ScreenText

_BOX = " \t│|┃║"


class Menu(NamedTuple):
    options: list[str]
    highlight: int | None       # index into options
    first_row: int              # screen row of options[0]
    countdown: int | None = None


class Editor(NamedTuple):
    lines: list[str]            # logical lines, display wrapping removed


def _clean(line: str) -> str:
    return line.strip(_BOX)


def is_blank(screen: ScreenText) -> bool:
    return not any(line.strip() for line in screen.lines)


def _find(screen: ScreenText, pattern: str) -> int | None:
    regex = re.compile(pattern, re.I)
    return next((i for i, line in enumerate(screen.lines) if regex.search(line)), None)


def detect_post(screen: ScreenText) -> bool:
    return _find(screen, r"\bF12\b.*\bboot\b") is not None and detect_boot_menu(screen) is None


def _options(screen: ScreenText, start: int, stop: int) -> Menu | None:
    rows = [(i, _clean(screen.lines[i])) for i in range(start, stop)]
    rows = [(i, text) for i, text in rows if text]
    if not rows:
        return None
    first = rows[0][0]
    # A menu is one contiguous block of option rows.
    if [i for i, _ in rows] != list(range(first, first + len(rows))):
        return None
    hl = screen.highlight_row
    highlight = hl - first if hl is not None and first <= hl < first + len(rows) else None
    return Menu([text for _, text in rows], highlight, first)


def detect_boot_menu(screen: ScreenText) -> Menu | None:
    title = _find(screen, r"select boot device|boot (menu|options)\s*:?\s*$")
    footer = _find(screen, r"ENTER to select")
    if title is None or footer is None or footer <= title + 1:
        return None
    return _options(screen, title + 1, footer)


def _grub_header(screen: ScreenText) -> int | None:
    return _find(screen, r"GNU GRUB\s+version")


def detect_grub_menu(screen: ScreenText) -> Menu | None:
    header = _grub_header(screen)
    footer = _find(screen, r"Use the .* keys to select which entry")
    if header is None or footer is None or footer <= header + 1:
        return None
    menu = _options(screen, header + 1, footer)
    if not menu:
        return None
    countdown = next((int(m[1]) for line in screen.lines
                      if (m := re.search(r"executed automatically in (\d+)\s*s", line, re.I))), None)
    return menu._replace(countdown=countdown)


def detect_grub_editor(screen: ScreenText) -> Editor | None:
    header = _grub_header(screen)
    footer = _find(screen, r"Minimum Emacs-like screen editing")
    if header is None or footer is None or footer <= header + 1:
        return None
    rows = [line.rstrip() for line in screen.lines[header + 1:footer]]
    while rows and not rows[0].strip():
        rows.pop(0)
    while rows and not rows[-1].strip():
        rows.pop()
    lines, current = [], ""
    for row in rows:
        if len(row) >= screen.cols and row.endswith("\\"):
            current += row[:-1]
            continue
        lines.append(current + row)
        current = ""
    if current:
        lines.append(current)
    return Editor(lines) if lines else None


def detect_grub_auth(screen: ScreenText) -> bool:
    return _find(screen, r"Enter (username|password)\s*:") is not None


def detect_pxe_loading(screen: ScreenText) -> bool:
    return _find(screen, r"Start PXE over|Station IP address|NBP file") is not None


def detect_installer(screen: ScreenText) -> bool:
    return _find(screen, r"anaconda .* started|Starting installer|Starting automated install") is not None


def detect_kernel_boot(screen: ScreenText) -> bool:
    return _find(screen, r"^\[\s*\d+\.\d+\]\s+Linux version") is not None


def detect_installer_error(screen: ScreenText) -> bool:
    return _find(screen, r"Entering emergency mode|dracut-initqueue timeout|Could not fetch|Kernel panic") is not None


def detect_os_login(screen: ScreenText) -> bool:
    return _find(screen, r"\blogin:\s*$") is not None


_NETWORK = re.compile(r"\b(IPv4|IPv6|PXE|Network|NIC|LAN)\b", re.I)
_NOT_INSTALL = re.compile(r"local (drive|disk)|rescue|troubleshoot|memory test|boot from", re.I)


def option_id(index: int, label: str) -> str:
    return f"o{index}-" + hashlib.sha256(label.encode()).hexdigest()[:8]


def boot_options(menu: Menu) -> list[dict]:
    options = []
    for i, label in enumerate(menu.options):
        options.append({"id": option_id(i, label), "label": label, "selectable": bool(_NETWORK.search(label)),
                        "highlighted": i == menu.highlight, "recommended": False})
    ipv4 = [o for o in options if o["selectable"] and re.search(r"\bIPv4\b", o["label"], re.I)]
    preferred = [o for o in ipv4 if not re.search(r"\bUSB\b", o["label"], re.I)] or ipv4
    if preferred:
        preferred[0]["recommended"] = True
    return options


def grub_options(menu: Menu) -> list[dict]:
    options = []
    for i, label in enumerate(menu.options):
        options.append({"id": option_id(i, label), "label": label, "selectable": not _NOT_INSTALL.search(label),
                        "highlighted": i == menu.highlight, "recommended": False})
    return options
