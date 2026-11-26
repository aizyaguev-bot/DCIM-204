"""Pure rewrite of inst.repo / inst.ks hosts on the GRUB linux line."""
import pytest

from app.pxe.rewrite import RewriteError, key_hosts, rewrite_hash, rewrite_install_urls
from app.pxe.runner import edit_keys
from app.pxe.screen import Text

NEW = "192.168.136.101"
ENTRY = ("setparams 'Install Rocky Linux 9.4'\n"
         "linuxefi /images/rocky94/vmlinuz ip=dhcp inst.repo=http://webrepo/rocky/9.4/BaseOS/x86_64/os "
         "inst.ks=http://webrepo/ks/rocky94.cfg POSTFILE=http://webrepo/post/lab.sh quiet\n"
         "initrdefi /images/rocky94/initrd.img")


def rw(text, old="webrepo", new=NEW):
    return rewrite_install_urls(text, old, new)


def assert_only_spans_changed(before, result, new=NEW):
    """Every byte outside the replaced spans is identical."""
    rebuilt, pos = [], 0
    for change in result.changes:
        rebuilt.append(before[pos:change["start"]])
        assert before[change["start"]:change["end"]] == change["before"]
        rebuilt.append(new)
        pos = change["end"]
    rebuilt.append(before[pos:])
    assert "".join(rebuilt) == result.text


def test_rewrites_both_keys_and_keeps_everything_else():
    result = rw(ENTRY)
    assert [c["key"] for c in result.changes] == ["inst.repo", "inst.ks"]
    assert all(c["before"] == "webrepo" and c["after"] == NEW for c in result.changes)
    assert f"inst.repo=http://{NEW}/rocky/9.4/BaseOS/x86_64/os" in result.text
    assert f"inst.ks=http://{NEW}/ks/rocky94.cfg" in result.text
    assert "POSTFILE=http://webrepo/post/lab.sh" in result.text           # POSTFILE untouched
    assert result.text.split("\n")[0] == ENTRY.split("\n")[0]
    assert result.text.split("\n")[2] == "initrdefi /images/rocky94/initrd.img"
    assert_only_spans_changed(ENTRY, result)
    assert [w["code"] for w in result.warnings] == ["other_occurrence"]
    assert result.warnings[0]["key"] == "POSTFILE"


def test_initrd_and_other_lines_untouched_even_with_keys():
    text = ENTRY + " inst.repo=http://webrepo/x\nsomething inst.ks=http://webrepo/y"
    result = rw(text)
    lines = result.text.split("\n")
    assert lines[2].endswith("inst.repo=http://webrepo/x") and lines[3] == "something inst.ks=http://webrepo/y"
    assert len(result.changes) == 2
    assert_only_spans_changed(text, result)


@pytest.mark.parametrize("host", ["webrepo2", "webrepo.example", "webrepo-old", "mywebrepo", "webrepo.lab.local"])
def test_similar_hosts_are_not_replaced(host):
    text = f"linux /vmlinuz inst.repo=http://{host}/os inst.ks=http://webrepo/ks.cfg"
    result = rw(text)
    assert [c["key"] for c in result.changes] == ["inst.ks"]
    assert f"inst.repo=http://{host}/os" in result.text
    assert any(w["code"] == "unexpected_host" and w["key"] == "inst.repo" for w in result.warnings)


def test_host_match_is_case_insensitive_and_keeps_scheme_port_path_query():
    text = "linuxefi /vmlinuz inst.repo=HTTPS://WebRepo:8443/a/b?x=1&y=webrepo#f inst.ks=http://webrepo:80/k.cfg?v=2"
    result = rw(text)
    assert f"inst.repo=HTTPS://{NEW}:8443/a/b?x=1&y=webrepo#f" in result.text
    assert f"inst.ks=http://{NEW}:80/k.cfg?v=2" in result.text
    assert result.changes[0]["before"] == "WebRepo"
    assert_only_spans_changed(text, result)


@pytest.mark.parametrize("quote", ['"', "'"])
def test_quoted_values(quote):
    text = f"linux /vmlinuz inst.repo={quote}http://webrepo/a b{quote} inst.ks={quote}http://webrepo/k.cfg{quote} quiet"
    result = rw(text)
    assert result.text == (f"linux /vmlinuz inst.repo={quote}http://{NEW}/a b{quote} "
                           f"inst.ks={quote}http://{NEW}/k.cfg{quote} quiet")
    assert_only_spans_changed(text, result)


def test_unbalanced_quote_is_rejected():
    with pytest.raises(RewriteError) as exc:
        rw('linux /vmlinuz inst.repo="http://webrepo/a inst.ks=http://webrepo/k')
    assert exc.value.code in ("unbalanced_quote", "missing_key")


@pytest.mark.parametrize("text,code", [
    ("linux /vmlinuz inst.repo=http://webrepo/a", "missing_key"),
    ("linux /vmlinuz inst.ks=http://webrepo/a", "missing_key"),
    ("linux /vmlinuz inst.repo=http://webrepo/a inst.repo=http://webrepo/b inst.ks=http://webrepo/k", "ambiguous_key"),
    ("linux /vmlinuz inst.repo=http://webrepo/a inst.ks=http://webrepo/k inst.ks=http://webrepo/j", "ambiguous_key"),
    ("linux /vmlinuz inst.repo=nfs:webrepo:/export inst.ks=http://webrepo/k", "unsupported_scheme"),
    ("linux /vmlinuz inst.repo=ftp://webrepo/a inst.ks=http://webrepo/k", "unsupported_scheme"),
    ("linux /vmlinuz inst.repo=cdrom inst.ks=http://webrepo/k", "unsupported_scheme"),
    ("linux /vmlinuz inst.repo=http://user:pw@webrepo/a inst.ks=http://webrepo/k", "credentials_in_url"),
    ("initrd /initrd.img inst.repo=http://webrepo/a inst.ks=http://webrepo/k", "missing_linux_line"),
    ("linux /a inst.repo=http://webrepo/a inst.ks=http://webrepo/k\nlinuxefi /b", "ambiguous_linux_line"),
])
def test_errors(text, code):
    with pytest.raises(RewriteError) as exc:
        rw(text)
    assert exc.value.code == code


def test_similar_key_names_are_not_counted():
    text = "linux /vmlinuz inst.repo=http://webrepo/a inst.repo2=http://webrepo/b xinst.ks=1 inst.ks=http://webrepo/k"
    result = rw(text)
    assert [c["key"] for c in result.changes] == ["inst.repo", "inst.ks"]
    assert "inst.repo2=http://webrepo/b" in result.text


def test_idempotent():
    once = rw(ENTRY)
    twice = rw(once.text)
    assert twice.text == once.text and twice.changes == []
    assert key_hosts(once.text) == {"inst.repo": NEW, "inst.ks": NEW}


def test_wrapped_lines_with_backslash_continuation():
    text = ("setparams 'x'\n"
            "linuxefi /vmlinuz ip=dhcp inst.repo=http://web\\\n"
            "repo/os inst.ks=http://webrepo\\\n"
            "/k.cfg quiet\n"
            "initrdefi /initrd.img")
    result = rw(text)
    assert [c["key"] for c in result.changes] == ["inst.repo", "inst.ks"]
    assert result.changes[0]["before"] == "web\\\nrepo"            # span straddles the continuation
    assert result.text == ("setparams 'x'\n"
                           f"linuxefi /vmlinuz ip=dhcp inst.repo=http://{NEW}/os inst.ks=http://{NEW}\\\n"
                           "/k.cfg quiet\n"
                           "initrdefi /initrd.img")
    assert_only_spans_changed(text, result)


def test_continuation_joins_key_across_lines_and_initrd_continuation_is_separate():
    text = "linux /vmlinuz inst.\\\nrepo=http://webrepo/a \\\ninst.ks=http://webrepo/k\ninitrd /i inst.ks=http://webrepo/z"
    result = rw(text)
    assert len(result.changes) == 2
    assert result.text.endswith("initrd /i inst.ks=http://webrepo/z")
    assert_only_spans_changed(text, result)


def test_crlf_and_leading_whitespace():
    text = "setparams 'x'\r\n\tlinuxefi /vmlinuz inst.repo=http://webrepo/a inst.ks=http://webrepo/k\r\n\tinitrdefi /i\r\n"
    result = rw(text)
    assert result.text == text.replace("webrepo", NEW)
    assert_only_spans_changed(text, result)


def test_ipv6_literal_host_not_matched_and_new_host_validated():
    result = rw("linux /v inst.repo=http://[fd00::1]:8080/a inst.ks=http://webrepo/k")
    assert [c["key"] for c in result.changes] == ["inst.ks"]
    for bad in ("", "a b", "host/evil", "x;y"):
        with pytest.raises(ValueError):
            rewrite_install_urls(ENTRY, "webrepo", bad)
    with pytest.raises(ValueError):
        rewrite_install_urls(ENTRY, "WEBREPO", "webrepo")


def test_hash_depends_on_both_texts():
    assert rewrite_hash("a", "b") != rewrite_hash("a", "c") != rewrite_hash("b", "b")
    assert len(rewrite_hash("a", "b")) == 32


def _apply(lines, keys):
    """Applies editor keystrokes the way the GRUB editor does, for the subset used by edit_keys."""
    buf, row, col = list(lines), 0, 0
    for key in keys:
        line = buf[row]
        if isinstance(key, Text): buf[row] = line[:col] + key + line[col:]; col += len(key)
        elif key == "Up": row, col = max(0, row - 1), 0 if row == 0 else min(col, len(buf[max(0, row - 1)]))
        elif key == "Down": row = min(len(buf) - 1, row + 1); col = min(col, len(buf[row]))
        elif key == "Ctrl+A": col = 0
        elif key == "Ctrl+E": col = len(line)
        elif key == "Right": col = min(len(line), col + 1)
        elif key == "Left": col = max(0, col - 1)
        elif key == "Delete": buf[row] = line[:col] + line[col + 1:]
        elif key == "Backspace": buf[row] = line[:col - 1] + line[col:]; col -= 1
        else: raise AssertionError(key)
    return buf


@pytest.mark.parametrize("text", [ENTRY, "linux /v inst.ks=http://webrepo/k inst.repo=http://webrepo/r",
                                  "a\nb\n  linux /v inst.repo=http://webrepo/" + "x" * 200 + " inst.ks=http://webrepo/k q"])
def test_edit_keys_produce_expected_text(text):
    result = rw(text)
    lines = text.split("\n")
    keys = edit_keys(lines, result.changes, NEW)
    assert _apply(lines, keys) == result.text.split("\n")
    assert all(isinstance(k, Text) or k in ("Up", "Down", "Ctrl+A", "Ctrl+E", "Right", "Left", "Delete", "Backspace") for k in keys)
    assert edit_keys(lines, [], NEW) == []
