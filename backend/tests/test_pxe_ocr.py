"""Column-accurate OCR text grid (app.pxe.ocr_grid) on synthetic OCR word boxes; no picture, OCR engine or device."""
import re

import pytest

from app.pxe import parsers
from app.pxe.ocr_grid import (Frame, blank_frame, cell_metrics, find_frame, grid_from_boxes, inner_lines,
                              join_wrapped, screen_from_boxes, synthetic_boxes)
from app.pxe.rewrite import key_hosts, rewrite_install_urls
from app.pxe.runner import edit_keys
from app.pxe.screen import ScreenText
from app.pxe.sim_driver import SimulatedMachine
from tests.test_pxe_rewrite import ENTRY, NEW, _apply

KERNEL = ("    linuxefi /images/rocky94/vmlinuz ip=dhcp  inst.repo=http://webrepo/rocky/9.4/BaseOS/x86_64/os "
          "inst.ks=http://webrepo/ks/rocky94-lab.cfg  POSTFILE=http://webrepo/post/lab-post.sh quiet  rd.shell=0")
LOGICAL = ["setparams 'Install Rocky Linux 9.4'", "", KERNEL, "    initrdefi /images/rocky94/initrd.img"]
HEADER = "GNU GRUB  version 2.06"
EDITOR_HELP = ["      Minimum Emacs-like screen editing is supported. TAB lists",
               "      completions. Press Ctrl-x or F10 to boot, Ctrl-c or F2 for",
               "      a command-line or ESC to discard edits and return to the GRUB menu."]
MENU_HELP = ["      Use the Up and Down keys to select which entry is highlighted.",
             "      Press enter to boot the selected OS, `e' to edit the commands",
             "      before booting or `c' for a command-line."]
# cols, rows, cell width, cell height, picture width, picture height (800x600 leaves half a row unused)
GEOMETRY = {"128x48": (128, 48, 8, 16, 1024, 768), "80x25": (80, 25, 9, 16, 720, 400),
            "100x37": (100, 37, 8, 16, 800, 600)}
STYLES = {"unicode": ("┌", "┐", "└", "┘", "─", "│"), "ascii": ("+", "+", "+", "+", "-", "|")}
OCR_BARS = "lI!1|"


def wrap(line: str, inner: int) -> list[str]:
    """GRUB editor display: inner-1 characters and a '\\' in the last inner column, until the rest fits."""
    if len(line) < inner:
        return [line]
    chunks = [line[i:i + inner - 1] for i in range(0, len(line), inner - 1)]
    return [chunk + "\\" for chunk in chunks[:-1]] + [chunks[-1]]


def framed(cols: int, rows: int, body: list[str], help_lines: list[str], *, style: str = "unicode",
           bottom: int | None = None, plain_rows=()) -> list[str]:
    """A GRUB screen: centred header, box from column 1 to cols-2 starting on row 3, help text under it."""
    left, right = 1, cols - 2
    inner = right - left - 1
    bottom = rows - len(help_lines) - 3 if bottom is None else bottom
    out = [""] * rows
    out[1] = " " * ((cols - len(HEADER)) // 2) + HEADER
    if style in STYLES:
        tl, tr, bl, br, h, v = STYLES[style]
        out[3] = " " * left + tl + h * inner + tr
        out[bottom] = " " * left + bl + h * inner + br
    elif style == "ocr":                      # dashes for the top border, bottom border not read at all
        out[3] = " " * left + "r" + "-" * inner + "7"
    assert len(body) < bottom - 3, "the test body must fit inside the box"
    for i in range(4, bottom):
        content = body[i - 4] if i - 4 < len(body) else ""
        if style in STYLES:
            lbar = rbar = STYLES[style][5]
        elif style == "ocr":
            lbar, rbar = OCR_BARS[i % len(OCR_BARS)], OCR_BARS[(i + 2) % len(OCR_BARS)]
        else:                                 # "dropped": OCR saw bars only next to text, no borders at all
            lbar = rbar = "l" if content else " "
        if i in plain_rows:                   # inverse-video row whose bars were not read
            lbar = rbar = " "
        out[i] = (" " * left + lbar + content.ljust(inner) + rbar).rstrip()
    for k, text in enumerate(help_lines):
        out[bottom + 2 + k] = text
    return out


def editor_screen(geometry: str, logical: list[str], **kwargs) -> list[str]:
    cols, rows = GEOMETRY[geometry][:2]
    inner = cols - 4
    return framed(cols, rows, [row for line in logical for row in wrap(line, inner)], EDITOR_HELP, **kwargs)


def ocr(screen: list[str], geometry: str, *, jitter: int = 0) -> list[str]:
    cols, rows, cell_w, cell_h, width, height = GEOMETRY[geometry]
    boxes = synthetic_boxes(screen, cell_w=cell_w, cell_h=cell_h, jitter=jitter)
    lines, got_cols, got_rows = grid_from_boxes(boxes, image_width=width, image_height=height)
    assert (got_cols, got_rows) == (cols, rows)
    return lines


def trim(rows: list[str]) -> list[str]:
    rows = list(rows)
    while rows and not rows[0].strip():
        rows.pop(0)
    while rows and not rows[-1].strip():
        rows.pop()
    return rows


def editor_lines(lines: list[str], cols: int) -> list[str]:
    """The wiring proposed for parsers.detect_grub_editor: frame interior when there is a frame, else the old rows."""
    header = next(i for i, line in enumerate(lines) if re.search(r"GNU GRUB\s+version", line))
    footer = next(i for i, line in enumerate(lines) if re.search(r"Minimum Emacs-like screen editing", line))
    frame = find_frame(lines)
    if frame is not None and header < frame.top and frame.bottom < footer:
        rows, width = inner_lines(lines, frame), frame.right - frame.left - 1
    else:
        rows, width = [line.rstrip() for line in lines[header + 1:footer]], cols
    return join_wrapped(trim(rows), width)


# -- the whole path: synthetic boxes -> grid -> frame -> interior -> joined logical lines -------------------

@pytest.mark.parametrize("jitter", [0, 2])
@pytest.mark.parametrize("geometry", ["128x48", "80x25", "100x37"])
def test_ocr_grid_preserves_columns_and_wrap(geometry, jitter):
    cols, rows = GEOMETRY[geometry][:2]
    screen = editor_screen(geometry, LOGICAL)
    assert sum(row.endswith("\\│") for row in screen) >= 1          # the kernel line really wraps
    lines = ocr(screen, geometry, jitter=jitter)
    assert lines == [row.rstrip() for row in screen]                # every column, indent and double space
    frame = find_frame(lines)
    assert frame == Frame(3, rows - 6, 1, cols - 2)
    joined = join_wrapped(inner_lines(lines, frame), frame.right - frame.left - 1)
    assert trim(joined) == LOGICAL
    assert editor_lines(lines, cols) == LOGICAL


def test_one_low_score_word_sets_the_confidence():
    cols, rows, cell_w, cell_h, width, height = GEOMETRY["128x48"]
    screen = editor_screen("128x48", LOGICAL)
    boxes = synthetic_boxes(screen, cell_w=cell_w, cell_h=cell_h)
    boxes[len(boxes) // 2]["score"] = 0.42
    read = screen_from_boxes(boxes, image_width=width, image_height=height, image_blank=False)
    assert read.confidence == pytest.approx(0.42)
    assert read.lines == [row.rstrip() for row in screen]
    clean = screen_from_boxes(synthetic_boxes(screen, cell_w=cell_w, cell_h=cell_h, score=0.97),
                              image_width=width, image_height=height, image_blank=False)
    assert clean.confidence == pytest.approx(0.97)


def test_scaled_canvas_and_ink_tight_boxes_keep_the_columns():
    """A uniformly scaled console (7.5x15 px cells) and OCR boxes that hug the glyph ink, not the whole cell."""
    screen = editor_screen("128x48", LOGICAL)
    boxes = synthetic_boxes(screen, cell_w=7.5, cell_h=15.0)
    for box in boxes:
        narrow_start, narrow_end = box["text"][0] in "il1|!.:'│", box["text"][-1] in "il1|!.:'│"
        box["left"] += 3.0 if narrow_start else 1.0
        box["right"] -= 3.0 if narrow_end else 1.0
        if set(box["text"]) != {"│"}:
            box["top"] += 4.0
            box["bottom"] -= 3.0
        box["cx"], box["cy"] = (box["left"] + box["right"]) / 2, (box["top"] + box["bottom"]) / 2
    cell_w, cell_h, cols, rows = cell_metrics(boxes, image_width=960, image_height=720)
    assert (cell_w, cell_h, cols, rows) == (pytest.approx(7.5), pytest.approx(15.0), 128, 48)
    lines, _, _ = grid_from_boxes(boxes, image_width=960, image_height=720)
    assert lines == [row.rstrip() for row in screen]
    assert editor_lines(lines, cols) == LOGICAL


def test_join_wrapped_is_exact_about_the_edge():
    inner = 10
    rows = ["abcdefghi\\", "  jk  l", "a \\ b", "ends in \\", "123456789\\", "\\", "x" * 9 + "\\"]
    assert join_wrapped(rows, inner) == ["abcdefghi  jk  l", "a \\ b", "ends in \\", "123456789\\", "x" * 9]
    assert join_wrapped([], inner) == []
    # A break that falls on spaces: the spaces before the '\\' and at the start of the next row are kept.
    for geometry in GEOMETRY:
        inner = GEOMETRY[geometry][0] - 4
        line = "    linux /vmlinuz " + "a" * (inner - 22) + "    " + "tail  end"
        assert line[inner - 3:inner + 1] == "    "                 # two spaces each side of the break
        lines = ocr(editor_screen(geometry, ["setparams 'x'", line]), geometry, jitter=2)
        assert editor_lines(lines, GEOMETRY[geometry][0]) == ["setparams 'x'", line]


def test_overlapping_words_shift_right_instead_of_dropping_characters():
    boxes = synthetic_boxes(["alpha beta gamma delta", "x"], cell_w=8, cell_h=16)
    beta = next(box for box in boxes if box["text"] == "beta")
    beta.update(left=beta["left"] - 16, right=beta["right"] - 16, cx=beta["cx"] - 16)     # OCR put it 2 cells left
    lines, cols, rows = grid_from_boxes(boxes * 2, image_width=640, image_height=400)    # and every word twice
    assert (cols, rows) == (80, 25)
    first = lines[0]
    for word in ("alpha", "beta", "gamma", "delta"):
        assert first.count(word) == 2
    assert len(first.replace(" ", "")) == 2 * len("alphabetagammadelta")


# -- frame detection ---------------------------------------------------------------------------------------

def test_find_frame_on_a_grub_menu_with_a_highlighted_row():
    titles = ["Boot from local drive", "Install Rocky Linux 9.4", "Install Rocky Linux 8.10",
              "Troubleshooting - rescue a Rocky Linux system"]
    screen = framed(80, 25, [f" {title}" for title in titles], MENU_HELP, plain_rows={5})
    frame = find_frame(screen)
    assert frame == Frame(3, 19, 1, 78)
    assert trim(inner_lines(screen, frame)) == [f" {title}" for title in titles]
    # The menu parser works on the same rows once the frame is drawn out (row numbers are kept).
    cell_w, cell_h, width, height = 9, 16, 720, 400
    read = screen_from_boxes(synthetic_boxes(screen, cell_w=cell_w, cell_h=cell_h, jitter=2),
                             image_width=width, image_height=height, image_blank=False, highlight_row=5)
    assert read.highlight_row == 5 and read.lines == [row.rstrip() for row in screen]
    clean = read._replace(lines=blank_frame(read.lines, find_frame(read.lines)))
    menu = parsers.detect_grub_menu(clean)
    assert menu is not None and menu.options == titles and menu.highlight == 1
    assert parsers.detect_grub_menu(read) is None            # why the parser must use blank_frame once wired


@pytest.mark.parametrize("style", ["unicode", "ascii", "ocr"])
def test_find_frame_on_ascii_and_ocr_confused_borders(style):
    cols, rows = GEOMETRY["80x25"][:2]
    screen = editor_screen("80x25", LOGICAL, style=style)
    lines = ocr(screen, "80x25", jitter=2)
    frame = find_frame(lines)
    assert frame == Frame(3, rows - 6, 1, cols - 2)
    assert trim(join_wrapped(inner_lines(lines, frame), frame.right - frame.left - 1)) == LOGICAL


def test_border_rows_read_as_a_few_dashes_are_still_borders():
    """Tesseract often returns a long ──── border as a short run of dashes whose box still spans the row."""
    cols, rows, cell_w, cell_h, width, height = GEOMETRY["128x48"]
    screen = editor_screen("128x48", LOGICAL)
    boxes = synthetic_boxes(screen, cell_w=cell_w, cell_h=cell_h, jitter=2)
    top = next(box for box in boxes if box["text"].startswith("┌"))
    bottom = next(box for box in boxes if box["text"].startswith("└"))
    top["text"] = "———————"
    bottom.update(text="└———", right=bottom["left"] + 40 * cell_w)          # part of the bottom border read
    lines, _, _ = grid_from_boxes(boxes, image_width=width, image_height=height)
    assert lines[3] == " " + "—" * (cols - 2)
    assert lines[rows - 6] == " └" + "—" * 39
    assert find_frame(lines) == Frame(3, rows - 6, 1, cols - 2)
    assert editor_lines(lines, cols) == LOGICAL


def test_line_level_boxes_like_rapidocr():
    """RapidOCR returns text segments: words joined by single spaces in one box, split where the gap is wider."""
    cols, rows, cell_w, cell_h, width, height = GEOMETRY["80x25"]
    screen = editor_screen("80x25", LOGICAL)
    boxes = []
    for row, line in enumerate(screen):
        for match in re.finditer(r"\S+(?: \S+)*", line):
            left, right, top = match.start() * cell_w, match.end() * cell_w, row * cell_h
            boxes.append({"text": match.group(), "score": 0.9, "cx": (left + right) / 2, "cy": top + cell_h / 2,
                          "left": left, "top": top, "right": right, "bottom": top + cell_h})
    assert any(" " in box["text"] for box in boxes)
    lines, got_cols, got_rows = grid_from_boxes(boxes, image_width=width, image_height=height)
    assert (got_cols, got_rows) == (cols, rows)
    assert lines == [row.rstrip() for row in screen]
    assert editor_lines(lines, cols) == LOGICAL


def test_find_frame_when_ocr_saw_bars_only_next_to_text():
    """No border rows were read and bars only where they touch text: the box is the text block, content intact."""
    cols = GEOMETRY["128x48"][0]
    screen = editor_screen("128x48", LOGICAL, style="dropped")
    lines = ocr(screen, "128x48")
    frame = find_frame(lines)
    assert frame is not None and (frame.left, frame.right) == (1, cols - 2) and frame.top == 3
    assert editor_lines(lines, cols) == LOGICAL


@pytest.mark.parametrize("screen", [
    [],
    [""] * 25,
    ["", "   LAB PC FIRMWARE", "", "   F2 = Setup     F12 = Boot Menu", "   BIOS Version 1.25.0"],
    ["Rocky Linux 9.2 (Blue Onyx)", "Kernel 5.14.0-284.11.1.el9_2.x86_64 on an x86_64", "", "opt00 login: "],
    ["[    0.000000] Linux version 5.14.0-427.13.1.el9_4.x86_64", "[    1.204511] dracut: dracut-057"],
    ["", "  Please select boot device:", "", "  UEFI: IPv4 Intel(R) Ethernet Connection I219-LM",
     "  Windows Boot Manager", "", "  Up/Down to move selection   ENTER to select boot device"],
    ["load module ide-cd1", "lsmod shows usbhid ok 1", "l  short  l", "Install path is /mnt/sysimage!"],
    ["==============================", "  Please select boot device:", "  Hard disk", "Esc to exit"],
])
def test_find_frame_is_none_without_a_frame(screen):
    assert find_frame(screen) is None
    assert inner_lines(screen, None) == [row.rstrip() for row in screen]
    assert blank_frame(screen, None) == [row.rstrip() for row in screen]


def test_simulated_unframed_editor_reads_the_same_through_the_grid():
    """Today's simulator draws the editor without a frame; the proposed wiring keeps reading it unchanged."""
    machine = SimulatedMachine("ocr-grid", hostname="opt00")
    machine.phase = "editor"
    machine.buffer = list(machine.grub_entries[1][1])
    sim = machine.screen()
    assert find_frame(sim.lines) is None
    assert editor_lines(sim.lines, sim.cols) == parsers.detect_grub_editor(sim).lines == machine.buffer
    boxes = synthetic_boxes(sim.lines, cell_w=9, cell_h=16, jitter=2)
    read = screen_from_boxes(boxes, image_width=720, image_height=400, image_blank=False, source="simulated-ocr")
    assert (read.cols, read.rows, read.source) == (80, 25, "simulated-ocr")
    assert read.lines == [row.rstrip() for row in sim.lines]
    assert editor_lines(read.lines, read.cols) == machine.buffer


# -- screen_from_boxes and cell metrics ----------------------------------------------------------------------

def test_screen_from_boxes_without_words_is_blank_or_unreadable():
    blank = screen_from_boxes([], image_width=1024, image_height=768, image_blank=True)
    unread = screen_from_boxes([], image_width=1024, image_height=768, image_blank=False, source="ocr-test")
    assert blank == ScreenText([""] * 25, None, 80, 25, 1.0, "ocr")
    assert unread.confidence == 0.0 and unread.source == "ocr-test" and not any(unread.lines)
    junk = [{"text": "   ", "score": 0.9, "left": 0, "top": 0, "right": 8, "bottom": 16, "cx": 4, "cy": 8},
            {"text": "x", "score": 0.9, "left": "?", "top": 0, "right": 8, "bottom": 16}, None, {"text": "y"}]
    assert screen_from_boxes(junk, image_width=1024, image_height=768, image_blank=False).confidence == 0.0


@pytest.mark.parametrize("geometry", ["128x48", "100x37", "80x25"])
def test_screen_rows_and_cols_follow_the_picture_size(geometry):
    cols, rows, cell_w, cell_h, width, height = GEOMETRY[geometry]
    screen = editor_screen(geometry, LOGICAL)
    boxes = synthetic_boxes(screen, cell_w=cell_w, cell_h=cell_h)
    assert cell_metrics(boxes, image_width=width, image_height=height) == (cell_w, cell_h, cols, rows)
    read = screen_from_boxes(boxes, image_width=width, image_height=height, image_blank=False, highlight_row=7)
    assert (read.cols, read.rows, len(read.lines), read.highlight_row) == (cols, rows, rows, 7)
    assert read.source == "ocr" and read.confidence == pytest.approx(0.99)
    outside = screen_from_boxes(boxes, image_width=width, image_height=height, image_blank=False, highlight_row=rows)
    assert outside.highlight_row is None


def test_cell_metrics_falls_back_to_80x25_and_clamps():
    few = synthetic_boxes(["GNU GRUB", "", "ok"], cell_w=8, cell_h=16)
    assert len(few) == 3
    assert cell_metrics(few, image_width=1024, image_height=768) == (1024 / 80, 768 / 25, 80, 25)
    text = [f"row {i} " + "word " * (i % 7) + "end" for i in range(12)]
    wide = synthetic_boxes([line + " " * 200 + "far right edge" for line in text], cell_w=8, cell_h=16)
    cell_w, cell_h, cols, rows = cell_metrics(wide, image_width=2400, image_height=200)
    assert (cell_w, cell_h, cols, rows) == (8.0, 16.0, 240, 20)
    small = synthetic_boxes(text, cell_w=8, cell_h=16)
    assert cell_metrics(small, image_width=200, image_height=2000)[2:] == (40, 80)


# -- the real kernel command line from the rewrite tests ------------------------------------------------------

LONG = "a\nb\n  linux /v inst.repo=http://webrepo/" + "x" * 200 + " inst.ks=http://webrepo/k q"   # test_pxe_rewrite.py
INDENTED = "\n".join(line if line.startswith("setparams") else "    " + line for line in ENTRY.split("\n"))


@pytest.mark.parametrize("geometry", ["80x25", "128x48"])
@pytest.mark.parametrize("text", [ENTRY, INDENTED, LONG], ids=["entry", "indented", "long"])
def test_rewrite_fixture_cmdline_survives_the_round_trip(text, geometry):
    cols = GEOMETRY[geometry][0]
    original = text.split("\n")
    read = editor_lines(ocr(editor_screen(geometry, original), geometry, jitter=2), cols)
    assert read == original
    expected = rewrite_install_urls(text, "webrepo", NEW)
    result = rewrite_install_urls("\n".join(read), "webrepo", NEW)
    assert result.text == expected.text and result.changes == expected.changes
    # What the runner does next: type the edit, read the screen again and compare it with the expected text.
    edited = _apply(read, edit_keys(read, result.changes, NEW))
    assert edited == expected.text.split("\n")
    verified = editor_lines(ocr(editor_screen(geometry, edited), geometry, jitter=2), cols)
    assert verified == expected.text.split("\n")
    assert set(key_hosts("\n".join(verified)).values()) == {NEW}
