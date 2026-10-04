"""
The private review checklist for one run: `<run>/review.md`.

It contains recognized text and local replay commands, so it lives only in the run directory.
`bench report` reads back the ticked boxes as counts; it never copies the text anywhere.
"""

from __future__ import annotations

import re
import shlex
from collections.abc import Sequence
from pathlib import Path

from .analysis import ReviewPick

REPLAY_OPTIONS = ("clean", "clipped start", "clipped end", "extra speech")
TEXT_OPTIONS = ("fine", "minor fix", "major fix", "missing speech")

_ITEM = re.compile(r"^### (R\d{2}) ", re.M)
_TICKED = re.compile(r"\[[xX]\] ([a-z ]+?)(?=\s+\[|\s*$)")
_SECONDS = re.compile(r"^- Correction time \(seconds\):[ \t]*([0-9]+(?:\.[0-9]+)?)?[ \t]*$", re.M)


def _clock(ms: int) -> str:
    return f"{ms // 60000}:{ms % 60000 / 1000:06.3f}"


def _boxes(options: Sequence[str]) -> str:
    return "  ".join(f"[ ] {option}" for option in options)


def write_review(
    path: Path, *, label: str, run_id: str, audio: Path, picks: Sequence[ReviewPick]
) -> None:
    lines = [
        f"# Review — {label} — {run_id}",
        "",
        "Private: this file contains recognized text and local paths. Keep it under",
        "~/.pebble; never commit, paste or share it.",
        "",
        "For each line, replay it, then tick one box per row (`[x]`). Correction time is how",
        "long fixing the text would take, roughly, in seconds. `bench report` counts the ticks.",
        "",
    ]
    for n, pick in enumerate(picks, start=1):
        segment = pick.segment
        start, end = segment.start_ms, segment.end_ms
        flags = (
            ", ".join(segment.review.flags) if segment.review and segment.review.flags else "none"
        )
        replay = (
            f"ffplay -nodisp -autoexit -ss {start / 1000:.3f} -t {(end - start) / 1000:.3f} "
            f"{shlex.quote(str(audio))}"
        )
        lines += [
            f"### R{n:02d} · {_clock(start)}–{_clock(end)} ({(end - start) / 1000:.2f} s) · "
            f"chunk {segment.chunk_index} · {segment.id}",
            "",
            f"- Why: {', '.join(pick.reasons)} · flags: {flags}",
            f"- Replay: `{replay}`",
            f"- Text: {segment.text}",
            f"- Replay range: {_boxes(REPLAY_OPTIONS)}",
            f"- Text quality: {_boxes(TEXT_OPTIONS)}",
            "- Correction time (seconds): ",
            "- Note: ",
            "",
        ]
    path.write_text("\n".join(lines), encoding="utf-8")


def read_ratings(path: Path) -> dict[str, object]:
    """Counts of ticked boxes and correction times. Never returns any text from the file."""
    content = path.read_text(encoding="utf-8")
    items = _ITEM.split(content)[1:]
    replay = dict.fromkeys(REPLAY_OPTIONS, 0)
    quality = dict.fromkeys(TEXT_OPTIONS, 0)
    seconds: list[float] = []
    rated = 0
    for body in items[1::2]:
        ticked_any = False
        for line in body.splitlines():
            if line.startswith("- Replay range:"):
                for option in _TICKED.findall(line):
                    if option in replay:
                        replay[option] += 1
                        ticked_any = True
            elif line.startswith("- Text quality:"):
                for option in _TICKED.findall(line):
                    if option in quality:
                        quality[option] += 1
                        ticked_any = True
        match = _SECONDS.search(body)
        if match and match.group(1):
            seconds.append(float(match.group(1)))
        rated += ticked_any
    return {
        "items": len(items) // 2,
        "rated": rated,
        "replayRange": replay,
        "textQuality": quality,
        "correctionSeconds": {"rated": len(seconds), "total": round(sum(seconds), 1)},
    }
