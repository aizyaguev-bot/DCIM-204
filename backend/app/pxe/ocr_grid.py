"""Column-accurate text grid from OCR word boxes (standard library only, no image or OCR imports).

A KVM console picture is a fixed-pitch character grid. OCR returns words with pixel boxes; this module
estimates the character cell from the boxes themselves, puts every word back on its own column (so
leading indentation and repeated spaces survive), finds the GRUB menu/editor frame and undoes the GRUB
editor's '\\' line wrapping. It never touches devices, images or the network.

A box is the dict `_read_tesseract` / `_read_rapidocr` produce: text, score, cx, cy, left, top, right,
bottom (pixels). Extra keys (for example "row" or "bg") are ignored.
"""
import math
import random
import re
from collections import Counter
from statistics import median
from typing import NamedTuple

from .screen import ScreenText

FALLBACK_COLS, FALLBACK_ROWS = 80, 25
MIN_COLS, MAX_COLS = 40, 240
MIN_ROWS, MAX_ROWS = 20, 80
MIN_BOXES = 4                  # fewer usable words than this: assume the classic 80x25 text screen
MIN_FRAME_WIDTH = 12           # right border column minus left border column

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# Vertical border as drawn, as ASCII, and as OCR commonly misreads it.
_VBAR = frozenset("│┃║|¦lI!1")
# Horizontal border as drawn, as ASCII, and as OCR commonly misreads it.
_HBAR = frozenset("─━═-—–_~=")
_CORNER = frozenset("┌┐└┘╔╗╚╝╭╮╰╯├┤┬┴┼+.,'`rLJ7F") | _VBAR | _HBAR
# Characters of a border row as OCR returns it; such a box is stretched over the cells it covers.
_RULE_TEXT = _HBAR | frozenset("┌┐└┘╔╗╚╝╭╮╰╯├┤┬┴┼+")


class Frame(NamedTuple):
    top: int        # all four are inclusive frame rows/columns
    bottom: int
    left: int
    right: int


class _Box(NamedTuple):
    text: str
    score: float
    left: float
    top: float
    right: float
    bottom: float
    cx: float
    cy: float


class _Geometry(NamedTuple):
    cell_w: float
    cell_h: float
    cols: int
    rows: int
    x0: float       # pixel offset of column 0 (0 when the text starts at the picture edge)
    y0: float       # pixel offset of row 0


# -- boxes -----------------------------------------------------------------------------------------------

def _number(value) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("not a finite number")
    return number


def _usable(boxes) -> list[_Box]:
    """Well-formed boxes with visible text; anything malformed is skipped, never guessed."""
    out = []
    for box in boxes or []:
        try:
            text = _CONTROL.sub(" ", str(box.get("text") or "")).strip()
            left, top, right, bottom = (_number(box[key]) for key in ("left", "top", "right", "bottom"))
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
        if not text or right < left or bottom < top:
            continue
        try:
            cx = _number(box["cx"]) if box.get("cx") is not None else (left + right) / 2
            cy = _number(box["cy"]) if box.get("cy") is not None else (top + bottom) / 2
        except (TypeError, ValueError):
            cx, cy = (left + right) / 2, (top + bottom) / 2
        try:
            score = min(1.0, max(0.0, _number(box.get("score", 0.0))))
        except (TypeError, ValueError):
            score = 0.0
        out.append(_Box(text, score, left, top, right, bottom, cx, cy))
    return out


# -- cell size -------------------------------------------------------------------------------------------

def _wrap_cells(value: float) -> float:
    """Fraction of a cell folded into [-0.5, 0.5)."""
    return value - math.floor(value + 0.5)


def _phase(positions, period: float) -> float:
    """Circular mean of positions modulo the period, in cells, folded into [-0.5, 0.5)."""
    k = 2 * math.pi / period
    re_ = sum(math.cos(k * x) for x in positions)
    im_ = sum(math.sin(k * x) for x in positions)
    if math.hypot(re_, im_) < 1e-9:
        return 0.0
    return _wrap_cells(math.atan2(im_, re_) / (2 * math.pi))


def _coherence(sets, period: float) -> float:
    """How well each set of positions sits on one grid of this period (1.0 = perfectly)."""
    k = 2 * math.pi / period
    total = count = 0
    for positions in sets:
        re_ = im_ = 0.0
        for x in positions:
            angle = k * x
            re_ += math.cos(angle)
            im_ += math.sin(angle)
        total += math.hypot(re_, im_)
        count += len(positions)
    return total / count if count else 0.0


def _period(sets, prior: float, low: float, high: float) -> float | None:
    """The grid pitch that best explains the positions, searched in [low, high].

    Positions on a pitch p also sit on p/2, p/3...; the search range excludes those, and among
    equally strong peaks the one nearest the prior wins. None when the positions do not decide it.
    """
    sets = [list(s) for s in sets if s]
    extent = max((abs(x) for s in sets for x in s), default=0.0)
    if not sets or extent <= 0 or not 0 < low < high:
        return None
    step = max(prior * 2e-4, prior / (8 * max(1.0, extent / prior)))
    grid = [low + i * step for i in range(int((high - low) / step) + 1)]
    values = [_coherence(sets, p) for p in grid]
    best = max(values)
    # Random positions reach about 1/sqrt(n) by chance; a flat curve means the positions cannot tell.
    if best < max(0.3, 2 / math.sqrt(sum(len(s) for s in sets))) or best - median(values) < 0.15:
        return None
    peaks = [i for i, v in enumerate(values) if v >= 0.9 * best
             and (i == 0 or v >= values[i - 1]) and (i == len(values) - 1 or v >= values[i + 1])]
    index = min(peaks, key=lambda i: (abs(grid[i] - prior), -values[i]))
    lo, hi = grid[index] - step, grid[index] + step
    for _ in range(40):                       # ternary search inside one peak
        m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
        if _coherence(sets, m1) < _coherence(sets, m2):
            lo = m1
        else:
            hi = m2
    return (lo + hi) / 2


def _snap(size: float, pitch: float, sets) -> float:
    """Prefer a whole-pixel cell (unscaled console) and then a pitch that tiles the picture exactly (uniformly
    scaled console), when the positions fit it about as well; sparse screens otherwise drift by a fraction."""
    fit = 0.75 * _coherence(sets, pitch)
    whole = round(pitch)
    if whole >= 4 and abs(pitch - whole) <= 0.02 * pitch and _coherence(sets, whole) >= fit:
        return float(whole)
    count = size / pitch
    nearest = round(count)
    if nearest > 0 and abs(count - nearest) < 0.05:
        return size / nearest
    return pitch


def _geometry(boxes: list[_Box], image_width, image_height) -> _Geometry:
    width = float(image_width) if image_width and image_width > 0 else 0.0
    height = float(image_height) if image_height and image_height > 0 else 0.0
    fallback = _Geometry((width or FALLBACK_COLS * 8.0) / FALLBACK_COLS,
                         (height or FALLBACK_ROWS * 16.0) / FALLBACK_ROWS, FALLBACK_COLS, FALLBACK_ROWS, 0.0, 0.0)
    if len(boxes) < MIN_BOXES or not width or not height:
        return fallback

    # Horizontal: word left/right edges and single-glyph centres all sit on the column pitch.
    words = [b for b in boxes if len(b.text) >= 2]
    singles = [b for b in boxes if len(b.text) == 1]
    per_char = [(b.right - b.left) / len(b.text) for b in boxes if len(b.text) >= 3 and b.right > b.left]
    x_sets = [[b.left for b in words], [b.right for b in words], [b.cx for b in singles]]
    cell_w = x0 = None
    if len(per_char) >= 2:
        prior = median(per_char)
        cell_w = _period(x_sets, prior, 0.82 * prior, 1.35 * prior)
    if cell_w:
        cell_w = _snap(width, cell_w, x_sets)
        lefts = [b.left for b in words]
        if len(lefts) >= 3:
            x0 = _phase(lefts, cell_w) * cell_w
        elif singles:
            x0 = _wrap_cells(_phase([b.cx for b in singles], cell_w) - 0.5) * cell_w

    # Vertical: word centres sit half a row below each row's top. Glyph ink is shorter than the cell,
    # so the pitch comes from the spacing of the rows, not from the box heights.
    heights = [b.bottom - b.top for b in boxes if b.bottom > b.top]
    tall = median(heights) if heights else 0.0
    if cell_w:
        low, high = max(1.3 * cell_w, 0.9 * tall), 2.6 * cell_w
        if low >= high:
            low = 1.3 * cell_w
        prior = tall if 1.5 * cell_w <= tall <= high else 2 * cell_w
    else:
        low, high, prior = 0.9 * tall, 2.2 * tall, tall
    centres = [b.cy for b in boxes]
    cell_h = None
    if tall > 0 and len({round(c / prior) for c in centres}) >= 2:      # one text row cannot give a pitch
        cell_h = _period([centres], prior, low, high)
    if cell_h:
        cell_h = _snap(height, cell_h, [centres])
    y0 = _wrap_cells(_phase(centres, cell_h) - 0.5) * cell_h if cell_h else None

    if not cell_w and not cell_h:
        return fallback
    if not cell_w:
        cell_w, x0 = cell_h / 2, 0.0
    if not cell_h:
        cell_h, y0 = 2 * cell_w, 0.0
    cols = min(MAX_COLS, max(MIN_COLS, int(math.floor(width / cell_w + 0.2))))
    rows = min(MAX_ROWS, max(MIN_ROWS, int(math.floor(height / cell_h + 0.2))))
    return _Geometry(cell_w, cell_h, cols, rows, x0 or 0.0, y0 or 0.0)


def cell_metrics(boxes, *, image_width: int, image_height: int) -> tuple[float, float, int, int]:
    """(cell_w, cell_h, cols, rows) estimated from word boxes; cols/rows derived from the image size, not fixed 80x25.

    Fallback when boxes are too few: 80x25. Cols are clamped to 40..240 and rows to 20..80.
    """
    geo = _geometry(_usable(boxes), image_width, image_height)
    return geo.cell_w, geo.cell_h, geo.cols, geo.rows


# -- grid ------------------------------------------------------------------------------------------------

def _stretch(text: str, cells: int) -> str:
    """A border row OCR read as a few dashes, drawn over every cell its box covers (corners kept)."""
    fill = Counter(ch for ch in text if ch in _HBAR).most_common(1)
    fill = fill[0][0] if fill else "-"
    first = text[0] if text[0] not in _HBAR else fill
    last = text[-1] if len(text) > 1 and text[-1] not in _HBAR else fill
    return first + fill * (cells - 2) + last


def _place(boxes: list[_Box], geo: _Geometry) -> list[str]:
    by_row: dict[int, list[tuple[int, float, float, str]]] = {}
    for box in boxes:
        text = box.text
        cells = math.floor((box.right - box.left) / geo.cell_w + 0.5)
        if set(text) <= _RULE_TEXT and cells >= 1.5 * len(text) + 2:
            text = _stretch(text, cells)
        if len(text) == 1:
            # A lone narrow glyph (a border bar, '1', 'l') has its ink in the middle of the cell.
            start = math.floor((box.cx - geo.x0) / geo.cell_w)
        else:
            start = math.floor((box.left - geo.x0) / geo.cell_w + 0.5)
        row = math.floor((box.cy - geo.y0) / geo.cell_h)
        row = min(geo.rows - 1, max(0, row))
        by_row.setdefault(row, []).append((max(0, start), box.left, box.right, text))
    lines = [""] * geo.rows
    for row, words in by_row.items():
        cells = [" "] * geo.cols
        end, previous_right = 0, None
        for start, left, right, text in sorted(words, key=lambda w: (w[0], w[1])):
            if start < end:
                # Never drop characters: push an overlapping word right, keeping a space if the picture had one.
                gap = (left - previous_right) / geo.cell_w if previous_right is not None else 0.0
                start = end + (1 if gap >= 0.5 else 0)
            if start + len(text) > len(cells):
                cells.extend(" " * (start + len(text) - len(cells)))
            cells[start:start + len(text)] = text
            end, previous_right = start + len(text), right
        lines[row] = "".join(cells).rstrip()
    return lines


def grid_from_boxes(boxes, *, image_width: int, image_height: int) -> tuple[list[str], int, int]:
    """Place every word at its column (left edge / cell width) on row int(cy / cell_h).

    Leading spaces and multiple spaces are kept; lines are `cols` wide before the right-strip;
    overlapping words never drop characters (they shift right). Returns (lines, cols, rows).
    """
    usable = _usable(boxes)
    geo = _geometry(usable, image_width, image_height)
    return _place(usable, geo), geo.cols, geo.rows


# -- frame -----------------------------------------------------------------------------------------------

def _span(line: str) -> tuple[int, int] | None:
    stripped = line.strip(" ")
    if not stripped:
        return None
    first = len(line) - len(line.lstrip(" "))
    return first, first + len(stripped) - 1


def _rule_span(line: str, span) -> tuple[int, int] | None:
    """(first, last) column of a horizontal border row, or None."""
    if span is None:
        return None
    first, last = span
    segment = line[first:last + 1]
    if len(segment) < MIN_FRAME_WIDTH or segment[0] not in _CORNER or segment[-1] not in _CORNER:
        return None
    body = segment[1:-1]
    ink = [ch for ch in body if ch != " "]
    if len(ink) < 0.5 * len(body) or sum(ch in _HBAR for ch in ink) < 0.85 * len(ink):
        return None
    return span


def _classify(grid, spans, rules, left, right) -> list[str]:
    classes = []
    for i, line in enumerate(grid):
        span = spans[i]
        if span is None:
            classes.append("blank")
            continue
        first, last = span
        rule = rules.get(i)
        if rule and rule[0] >= left - 1 and rule[1] <= right + 1:
            # A border row, whole or partly read; it is never frame content.
            classes.append("rule")
            continue
        left_bar = first == left and line[left] in _VBAR
        right_bar = last == right and line[right] in _VBAR
        # One column of overflow is tolerated when it is clearly a border bar pushed right/left by OCR.
        if last == right + 1 and line[last] in _VBAR and first >= left:
            right_bar = True
        elif first == left - 1 and line[first] in _VBAR and last <= right:
            left_bar = True
        elif first < left or last > right:
            classes.append("out")
            continue
        classes.append("both" if left_bar and right_bar else "one" if left_bar or right_bar else "inner")
    return classes


def _frame_for(classes, left, right):
    """Best (evidence, inner height, Frame) for one pair of border columns, or None."""
    n = len(classes)
    best = None
    i = 0
    while i < n:
        if classes[i] in ("rule", "out"):
            i += 1
            continue
        a = i
        while i < n and classes[i] not in ("rule", "out"):
            i += 1
        b = i - 1
        sides = [r for r in range(a, b + 1) if classes[r] in ("both", "one")]
        top_rule = a - 1 if a > 0 and classes[a - 1] == "rule" else None
        bottom_rule = b + 1 if b + 1 < n and classes[b + 1] == "rule" else None
        if top_rule is not None:
            top = top_rule
        elif sides:
            start = sides[0]
            while start - 1 >= a and classes[start - 1] == "inner":
                start -= 1
            top = start - 1
        else:
            continue
        if bottom_rule is not None:
            bottom = bottom_rule
        elif sides:
            end = sides[-1]
            while end + 1 <= b and classes[end + 1] == "inner":
                end += 1
            bottom = end + 1
        else:
            continue
        if top < 0 or bottom >= n or bottom - top < 2:
            continue
        inside = classes[top + 1:bottom]
        rules = (top_rule is not None) + (bottom_rule is not None)
        both, one = inside.count("both"), inside.count("one")
        # Plain text can start and end with l/I/1 by chance; a frame needs two border rows, or one border row
        # and a bar, or two rows with both bars at the same columns.
        if not (rules == 2 or (rules == 1 and both + one) or both >= 2):
            continue
        evidence = 2 * rules + both + 0.5 * one
        candidate = (evidence, bottom - top, Frame(top, bottom, left, right))
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    return best


def find_frame(lines: list[str]) -> Frame | None:
    """The GRUB menu/editor box: box-drawing chars (─│┌┐└┘ and ASCII +-|), tolerating common OCR confusions
    (l, I, !, 1 for │; dashes or nothing for ─). None when the screen has no frame."""
    if not lines:
        return None
    grid = [str(line or "").replace("\t", " ") for line in lines]
    width = max(len(line) for line in grid) + 2
    grid = [line.ljust(width) for line in grid]
    spans = [_span(line) for line in grid]
    rules = {i: rule for i, line in enumerate(grid) if (rule := _rule_span(line, spans[i]))}
    pairs = Counter()
    for i, line in enumerate(grid):
        span = spans[i]
        if span and i not in rules and span[1] - span[0] >= MIN_FRAME_WIDTH \
                and line[span[0]] in _VBAR and line[span[1]] in _VBAR:
            pairs[span] += 1
    for span in rules.values():
        pairs[span] += 1
    best = None
    for left, right in pairs:
        found = _frame_for(_classify(grid, spans, rules, left, right), left, right)
        if found and (best is None or found[:2] > best[:2]):
            best = found
    return best[2] if best else None


def inner_lines(lines: list[str], frame: Frame | None) -> list[str]:
    """Rows strictly inside the frame, columns strictly inside it, right-stripped; whole screen if frame is None."""
    if frame is None:
        return [str(line or "").rstrip() for line in lines]
    return [str(line or "")[frame.left + 1:frame.right].rstrip() for line in lines[frame.top + 1:frame.bottom]]


def blank_frame(lines: list[str], frame: Frame | None) -> list[str]:
    """The same screen with the frame drawn out: border rows emptied, border columns and anything outside them on
    inner rows replaced by spaces. Row numbers and content columns are unchanged (for menu parsers)."""
    out = [str(line or "").rstrip() for line in lines]
    if frame is None:
        return out
    for i in range(max(0, frame.top), min(len(out), frame.bottom + 1)):
        if i in (frame.top, frame.bottom):
            out[i] = ""
        else:
            out[i] = (" " * (frame.left + 1) + out[i][frame.left + 1:frame.right]).rstrip()
    return out


def join_wrapped(lines: list[str], inner_width: int) -> list[str]:
    """GRUB editor wraps a long line by putting '\\' in the last inner column; join those continuations exactly.

    A row is a continuation only when its '\\' sits exactly in the last inner column; a '\\' anywhere else is text.
    """
    out, current = [], None
    for row in lines:
        row = str(row or "").rstrip()
        if inner_width > 0 and len(row) == inner_width and row.endswith("\\"):
            current = (current or "") + row[:-1]
            continue
        out.append((current or "") + row)
        current = None
    if current is not None:
        out.append(current)
    return out


# -- screen ----------------------------------------------------------------------------------------------

def screen_from_boxes(boxes, *, image_width: int, image_height: int, image_blank: bool,
                      highlight_row: int | None = None, source: str = "ocr") -> ScreenText:
    """Drop-in successor of raritan_driver.screen_from_observations.

    No readable words: blank lines with confidence 1.0 if the picture is blank, else 0.0 (unreadable is
    not the same as empty). Otherwise confidence is the lowest word score; cols/rows come from cell_metrics.
    """
    usable = _usable(boxes)
    geo = _geometry(usable, image_width, image_height)
    valid = isinstance(highlight_row, int) and not isinstance(highlight_row, bool)
    highlight = highlight_row if valid and 0 <= highlight_row < geo.rows else None
    if not usable:
        return ScreenText([""] * geo.rows, highlight, geo.cols, geo.rows, 1.0 if image_blank else 0.0, source)
    confidence = min(box.score for box in usable)
    return ScreenText(_place(usable, geo), highlight, geo.cols, geo.rows, confidence, source)


def synthetic_boxes(lines: list[str], *, cell_w: float = 8.0, cell_h: float = 16.0, score: float = 0.99,
                    jitter: int = 0) -> list[dict]:
    """Test/simulation helper: a text screen as OCR-like word boxes {text, score, cx, cy, left, top, right, bottom}.

    One box per whitespace-separated word, pixel geometry from the cell size; with jitter, every edge moves by a
    deterministic whole number of pixels in [-jitter, +jitter] (same input, same boxes).
    """
    rng = random.Random(0x0C2)
    spread = max(0, int(jitter))

    def shake() -> int:
        return rng.randint(-spread, spread) if spread else 0

    boxes = []
    for row, line in enumerate(lines):
        for match in re.finditer(r"\S+", str(line or "")):
            left = match.start() * cell_w + shake()
            right = match.end() * cell_w + shake()
            top = row * cell_h + shake()
            bottom = (row + 1) * cell_h + shake()
            boxes.append({"text": match.group(), "score": score, "cx": (left + right) / 2, "cy": (top + bottom) / 2,
                          "left": left, "top": top, "right": right, "bottom": bottom})
    return boxes
