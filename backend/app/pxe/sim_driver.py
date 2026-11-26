"""Simulated computer behind a KVM: POST, F12 boot menu, PXE, GRUB menu/editor and installer, on an injectable clock."""
import math
import random
import time

from . import rewrite
from .screen import ScreenDriverError, ScreenText, render_svg, validate_keys, Text

SCENARIOS = ("happy", "missed_f12", "no_pxe_entry", "countdown_expires", "grub_password", "missing_inst_ks",
             "duplicate_inst_repo", "ocr_noise", "kvm_disconnect", "installer_error")
COLS, ROWS = 80, 25
BOOT_ENTRIES = [
    "UEFI: IPv4 Intel(R) Ethernet Connection I219-LM",
    "UEFI: IPv6 Intel(R) Ethernet Connection I219-LM",
    "UEFI: IPv4 Realtek USB GbE Family Controller",
    "UEFI: IPv6 Realtek USB GbE Family Controller",
    "Windows Boot Manager",
    "BIOS Setup",
]
NO_PXE_ENTRIES = ["Windows Boot Manager", "UEFI: Samsung SSD 980 PRO 1TB", "BIOS Setup", "Diagnostics"]
INSTALLS = [("Install Rocky Linux 9.4", "rocky94", "rocky/9.4"), ("Install Rocky Linux 8.10", "rocky810", "rocky/8.10"),
            ("Install RHEL 9.4 (kickstart)", "rhel94", "rhel/9.4")]
LOCAL = "Boot from local drive"
RESCUE = "Troubleshooting - rescue a Rocky Linux system"
# Seconds at time_scale 1.
TIMINGS = {"manual": 2.0, "shutdown": 1.5, "post": 3.0, "pxe": 2.0, "countdown": 10.0, "kernel": 2.0,
           "installer": 2.0, "install": 20.0}
_NOISE = str.maketrans({"I": "l", "o": "0", "e": "c", "S": "5"})


def _wrap(line: str) -> list[str]:
    width = COLS - 1
    if len(line) <= width:
        return [line]
    chunks = [line[i:i + width] for i in range(0, len(line), width)]
    return [chunk + "\\" for chunk in chunks[:-1]] + [chunks[-1]]


class SimulatedMachine:
    def __init__(self, seed: str, scenario: str = "happy", clock=time.time, *, hostname: str = "opt00",
                 old_host: str = "webrepo", new_host: str = "192.168.136.101", time_scale: float = 1.0):
        if scenario not in SCENARIOS:
            raise ValueError("Unknown scenario")
        self.scenario, self.clock, self.hostname = scenario, clock, hostname
        self.old_host, self.new_host, self.scale = old_host, new_host, time_scale
        self.rng = random.Random(f"{seed}:{scenario}")
        self.boot_entries = list(NO_PXE_ENTRIES if scenario == "no_pxe_entry" else BOOT_ENTRIES)
        self.rng.shuffle(self.boot_entries)
        installs = list(INSTALLS)
        self.rng.shuffle(installs)
        self.grub_entries = [(LOCAL, [f"setparams '{LOCAL}'", "exit"])]
        self.grub_entries += [(title, self._entry_lines(title, image, path)) for title, image, path in installs]
        self.grub_entries.append((RESCUE, [f"setparams '{RESCUE}'",
                                           f"linuxefi /images/rocky94/vmlinuz ip=dhcp inst.repo=http://{old_host}/rocky/9.4/BaseOS/x86_64/os inst.ks=http://{old_host}/ks/rescue.cfg inst.rescue quiet",
                                           "initrdefi /images/rocky94/initrd.img"]))
        self.phase, self.phase_at = "os", clock()
        self.reboot_at: float | None = None
        self.f12_seen = False
        self.boot_hl = next((i for i, e in enumerate(self.boot_entries) if "IPv4 Intel" in e), 0)
        self.grub_hl = 0
        self.countdown_end: float | None = None
        self.buffer: list[str] = []
        self.cursor = [0, 0]
        self.booted: list[str] | None = None
        self.installed = False
        self.disconnected = False
        self.reads = 0
        self.keys: list[str] = []
        self.faults: set[str] = set()      # test hooks: "drop_last_char"
        self.power_cycles = 0

    def _entry_lines(self, title, image, path):
        host = self.old_host
        repo = f"inst.repo=http://{host}/{path}/BaseOS/x86_64/os"
        ks = f"inst.ks=http://{host}/ks/{image}-lab.cfg"
        if self.scenario == "missing_inst_ks":
            ks = ""
        if self.scenario == "duplicate_inst_repo":
            repo = f"{repo} inst.repo=http://{host}/{path}/AppStream/x86_64/os"
        args = " ".join(part for part in (f"linuxefi /images/{image}/vmlinuz ip=dhcp", repo, ks,
                                          f"POSTFILE=http://{host}/post/lab-post.sh", "quiet") if part)
        return [f"setparams '{title}'", args, f"initrdefi /images/{image}/initrd.img"]

    def _t(self, name: str) -> float:
        return TIMINGS[name] * self.scale

    def _enter(self, phase: str, at: float | None = None):
        self.phase, self.phase_at = phase, self.clock() if at is None else at
        if phase == "grub":
            self.grub_hl = 0
            seconds = 2.0 * self.scale if self.scenario == "countdown_expires" else self._t("countdown")
            self.countdown_end = self.phase_at + seconds
            if self.scenario == "kvm_disconnect":
                self.disconnected = True

    # -- external events -------------------------------------------------
    def schedule_reboot(self, after: float):
        self.reboot_at = self.clock() + after * self.scale

    def power_cycle(self):
        self.power_cycles += 1
        self._reboot(self.clock())

    def _reboot(self, at):
        self.f12_seen = False
        self.reboot_at = None
        self._enter("shutdown", at)

    # -- time ------------------------------------------------------------
    def _advance(self):
        for _ in range(20):
            now, at, phase = self.clock(), self.phase_at, self.phase
            if self.reboot_at is not None and now >= self.reboot_at and phase == "os":
                self._reboot(self.reboot_at)
            elif phase == "shutdown" and now >= at + self._t("shutdown"):
                self._enter("post", at + self._t("shutdown"))
            elif phase == "post" and now >= at + self._t("post"):
                after = "installed" if self.installed else "os"
                self._enter("boot_menu" if self.f12_seen else after, at + self._t("post"))
            elif phase == "pxe" and now >= at + self._t("pxe"):
                self._enter("grub", at + self._t("pxe"))
            elif phase == "grub" and self.countdown_end is not None and now >= self.countdown_end:
                end = self.countdown_end
                self.countdown_end = None
                self._boot_entry(self.grub_entries[self.grub_hl][1], end)
            elif phase == "kernel" and now >= at + self._t("kernel"):
                self._enter(self._kernel_outcome(), at + self._t("kernel"))
            elif phase == "installer_start" and now >= at + self._t("installer"):
                self._enter("installing", at + self._t("installer"))
            elif phase == "installing" and now >= at + self._t("install"):
                self.installed = True               # the installer finishes with a reboot into the new OS
                self._reboot(at + self._t("install"))
            else:
                return

    def _boot_entry(self, lines, at=None):
        self.booted = list(lines)
        if not any(rewrite._LINUX.match(line) for line in lines):
            self._enter("os", at)
        else:
            self._enter("kernel", at)

    def _kernel_outcome(self) -> str:
        if self.scenario == "installer_error":
            return "install_error"
        try:
            hosts = rewrite.key_hosts("\n".join(self.booted or []))
        except rewrite.RewriteError:
            return "install_error"
        ok = all(host.casefold() == self.new_host.casefold() for host in hosts.values())
        return "installer_start" if ok else "install_error"

    # -- keyboard --------------------------------------------------------
    def press(self, key: str):
        self._advance()
        self.keys.append(key)
        phase = self.phase
        if isinstance(key, Text) and phase != "editor":
            return
        if phase == "os":
            if key == "Ctrl+Alt+Delete":
                self._reboot(self.clock())
        elif phase in ("shutdown", "post"):
            if key == "F12" and self.scenario != "missed_f12":
                self.f12_seen = True
        elif phase == "boot_menu":
            if key in ("Up", "Down"):
                self.boot_hl = max(0, min(len(self.boot_entries) - 1, self.boot_hl + (1 if key == "Down" else -1)))
            elif key == "Enter":
                entry = self.boot_entries[self.boot_hl]
                self._enter("pxe" if ("IPv4" in entry or "IPv6" in entry) else "setup" if "Setup" in entry else "os")
            elif key == "Esc":
                self._enter("os")
        elif phase == "grub":
            self._grub_key(key)
        elif phase == "grub_auth":
            if key == "Esc":
                self.phase = "grub"
        elif phase == "editor":
            self._editor_key(key)

    def _grub_key(self, key):
        if self.countdown_end is not None:
            if self.scenario == "countdown_expires":
                return          # keystrokes lost while the countdown runs
            self.countdown_end = None
        if key in ("Up", "Down"):
            self.grub_hl = max(0, min(len(self.grub_entries) - 1, self.grub_hl + (1 if key == "Down" else -1)))
        elif key in ("Enter", "Right", "Ctrl+X"):
            self._boot_entry(self.grub_entries[self.grub_hl][1])
        elif key == "e":
            if self.scenario == "grub_password":
                self.phase = "grub_auth"
            else:
                self.buffer = list(self.grub_entries[self.grub_hl][1])
                self.cursor = [0, 0]
                self.phase = "editor"

    def _editor_key(self, key):
        buf, cur = self.buffer, self.cursor
        row, col = cur
        line = buf[row]
        if isinstance(key, Text):
            text = str(key)
            if "drop_last_char" in self.faults:
                self.faults.discard("drop_last_char")
                text = text[:-1]
            buf[row] = line[:col] + text + line[col:]
            cur[1] = col + len(text)
        elif key == "Up":
            cur[0] = max(0, row - 1)
            cur[1] = 0 if row == 0 else min(col, len(buf[cur[0]]))
        elif key == "Down":
            cur[0] = min(len(buf) - 1, row + 1)
            cur[1] = min(col, len(buf[cur[0]]))
        elif key == "Left":
            cur[1] = max(0, col - 1)
        elif key == "Right":
            cur[1] = min(len(line), col + 1)
        elif key in ("Ctrl+A", "Home"):
            cur[1] = 0
        elif key in ("Ctrl+E", "End"):
            cur[1] = len(line)
        elif key == "Delete":
            if col < len(line):
                buf[row] = line[:col] + line[col + 1:]
            elif row + 1 < len(buf):
                buf[row] = line + buf.pop(row + 1)
        elif key == "Backspace":
            if col > 0:
                buf[row] = line[:col - 1] + line[col:]
                cur[1] = col - 1
            elif row > 0:
                cur[0], cur[1] = row - 1, len(buf[row - 1])
                buf[row - 1] += buf.pop(row)
        elif key == "Ctrl+K":
            if col < len(line):
                buf[row] = line[:col]
            elif row + 1 < len(buf):
                buf[row] = line + buf.pop(row + 1)
        elif key == "Enter":
            buf[row:row + 1] = [line[:col], line[col:]]
            cur[0], cur[1] = row + 1, 0
        elif key == "Esc":
            self.buffer = []
            self.phase = "grub"
        elif key == "Ctrl+X":
            self._boot_entry(list(buf))
        elif key == "e":
            buf[row] = line[:col] + "e" + line[col:]
            cur[1] = col + 1

    # -- screen ----------------------------------------------------------
    def screen(self) -> ScreenText:
        self._advance()
        lines, highlight = self._render()
        lines = (lines + [""] * ROWS)[:max(ROWS, len(lines))]
        return ScreenText(lines, highlight, COLS, len(lines), 1.0, "simulated")

    def _render(self) -> tuple[list[str], int | None]:
        phase, host = self.phase, self.hostname
        if phase == "os":
            return ["Rocky Linux 9.2 (Blue Onyx)", "Kernel 5.14.0-284.11.1.el9_2.x86_64 on an x86_64", "",
                    f"{host} login: "], None
        if phase == "installed":
            return ["Rocky Linux 9.4 (Blue Onyx)", "Kernel 5.14.0-427.13.1.el9_4.x86_64 on an x86_64", "",
                    f"{host} login: "], None
        if phase == "shutdown":
            return [], None
        if phase == "post":
            return ["", "   LAB PC FIRMWARE", "", "   F2 = Setup     F12 = Boot Menu", "   BIOS Version 1.25.0"], None
        if phase == "setup":
            return ["BIOS Setup Utility", "", "Main  Advanced  Boot  Security  Exit"], None
        if phase == "boot_menu":
            lines = ["", "  Please select boot device:", ""]
            first = len(lines)
            lines += [f"  {entry}" for entry in self.boot_entries]
            lines += ["", "  Up/Down to move selection   ENTER to select boot device   ESC to boot using defaults"]
            return lines, first + self.boot_hl
        if phase == "pxe":
            return [">>Checking Media Presence......", ">>Media Present......", ">>Start PXE over IPv4.",
                    "  Station IP address is 192.0.2.57", "", ">>Downloading NBP file..."], None
        header = ["                             GNU GRUB  version 2.06", ""]
        if phase in ("grub", "grub_auth"):
            if phase == "grub_auth":
                return header + ["Enter username:", ""], None
            first = len(header)
            lines = header + [f" {title}" for title, _ in self.grub_entries]
            lines += ["", "      Use the Up and Down keys to select which entry is highlighted.",
                      "      Press enter to boot the selected OS, `e' to edit the commands",
                      "      before booting or `c' for a command-line."]
            if self.countdown_end is not None:
                left = max(0, math.ceil(self.countdown_end - self.clock()))
                lines.append(f"   The highlighted entry will be executed automatically in {left}s.")
            return lines, first + self.grub_hl
        if phase == "editor":
            lines = list(header)
            for line in self.buffer:
                lines += _wrap(line)
            lines += ["", "      Minimum Emacs-like screen editing is supported. TAB lists",
                      "      completions. Press Ctrl-x or F10 to boot, Ctrl-c or F2 for",
                      "      a command-line or ESC to discard edits and return to the GRUB menu."]
            return lines, None
        if phase == "kernel":
            return ["[    0.000000] Linux version 5.14.0-427.13.1.el9_4.x86_64", "[    1.204511] dracut: dracut-057"], None
        if phase == "installer_start":
            return ["Starting installer, one moment...", "anaconda 34.25.4.9-1.el9 for Rocky Linux 9.4 started.",
                    " * installation log files are stored in /tmp during the installation"], None
        if phase == "installing":
            return ["Installation", "", "Installing software packages...", "anaconda 34.25.4.9-1.el9 for Rocky Linux 9.4 started."], None
        if phase == "install_error":
            return ["[  OK  ] Started dracut initqueue hook.",
                    "dracut-initqueue[812]: Warning: Could not fetch kickstart file",
                    "Warning: dracut-initqueue timeout - starting timeout scripts",
                    "Entering emergency mode. Exit the shell to continue.", "dracut:/#"], None
        return [], None


class SimulatedScreenDriver:
    """ScreenDriver over a SimulatedMachine; ocr_noise corrupts every other text read."""

    def __init__(self, machine: SimulatedMachine):
        self.machine = machine
        self.opened = False

    def _check(self):
        if self.machine.disconnected:
            raise ScreenDriverError("KVM session disconnected")
        if not self.opened:
            raise ScreenDriverError("KVM session is not open")

    async def open(self):
        if self.machine.disconnected:
            raise ScreenDriverError("KVM session disconnected")
        self.opened = True

    async def close(self):
        self.opened = False

    async def screenshot(self) -> tuple[bytes, str]:
        self._check()
        return render_svg(self.machine.screen()), "image/svg+xml"

    async def send_keys(self, seq):
        keys = validate_keys(seq)
        self._check()
        for key in keys:
            self.machine.press(key)
            self._check()

    async def read_text(self) -> ScreenText:
        self._check()
        screen = self.machine.screen()
        self._check()
        self.machine.reads += 1
        if self.machine.scenario == "ocr_noise" and self.machine.reads % 2 == 1:
            return screen._replace(lines=[line.translate(_NOISE) for line in screen.lines], confidence=0.55, source="simulated-ocr")
        return screen


class SimulatedPower:
    def __init__(self, machine: SimulatedMachine):
        self.machine = machine

    async def cycle(self):
        self.machine.power_cycle()
