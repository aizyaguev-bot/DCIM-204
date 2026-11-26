"""Screen driver interface: read the console as text, take screenshots and press allowlisted keys only."""
import re
from typing import NamedTuple, Protocol
from xml.sax.saxutils import escape


class ScreenText(NamedTuple):
    lines: list[str]
    highlight_row: int | None
    cols: int
    rows: int
    confidence: float
    source: str


class ScreenDriverError(Exception):
    """The console session failed (disconnected, not readable); the message never contains secrets."""


KEYS = frozenset({
    "F12", "Up", "Down", "Left", "Right", "Enter", "Esc", "e", "Ctrl+A", "Ctrl+E", "Ctrl+K", "Ctrl+X",
    "Delete", "Backspace", "Home", "End", "Ctrl+Alt+Delete",
})
_TEXT = re.compile(r"[0-9A-Za-z.:-]+")


class Text(str):
    """Literal text to type; limited to repository host characters."""

    def __new__(cls, value: str):
        if not isinstance(value, str) or not _TEXT.fullmatch(value):
            raise ValueError("Text may contain only letters, digits, '.', '-' and ':'")
        return super().__new__(cls, value)


def validate_keys(seq) -> list:
    out = []
    for item in seq:
        if isinstance(item, Text):
            out.append(item)
        elif isinstance(item, str) and item in KEYS:
            out.append(item)
        else:
            raise ValueError("Key is not allowed")
    return out


class ScreenDriver(Protocol):
    async def open(self) -> None: ...
    async def close(self) -> None: ...
    async def screenshot(self) -> tuple[bytes, str]: ...
    async def send_keys(self, seq: list[str]) -> None: ...
    async def read_text(self) -> ScreenText: ...


_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def render_svg(screen: ScreenText) -> bytes:
    """Monospace SVG of a text screen; all text is XML-escaped."""
    cell_w, cell_h = 9, 18
    width, height = screen.cols * cell_w + 16, max(screen.rows, len(screen.lines)) * cell_h + 16
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
             f'<rect width="{width}" height="{height}" fill="#101010"/>']
    for row, line in enumerate(screen.lines):
        y = 8 + row * cell_h
        selected = row == screen.highlight_row
        if selected:
            parts.append(f'<rect x="4" y="{y}" width="{width - 8}" height="{cell_h}" fill="#c8c8c8"/>')
        text = escape(_CONTROL.sub(" ", line), {'"': "&quot;"})
        fill = "#101010" if selected else "#d8d8d8"
        parts.append(f'<text x="8" y="{y + 14}" fill="{fill}" font-family="Consolas, monospace" font-size="15" '
                     f'xml:space="preserve">{text}</text>')
    parts.append("</svg>")
    return "".join(parts).encode("utf-8")
