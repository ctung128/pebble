"""
`bench review --run <id>`: rebuilds a run's private review checklist from its saved transcript
and cut positions. It never transcribes, loads models or touches the network, and it doesn't
change `transcript.json` or `result.json`.
"""

from __future__ import annotations

import json
import os

from ..contract import parse_transcript
from ..storage import Storage, make_private
from .analysis import CutKind, category_counts, select_for_review
from .paths import run_file
from .results import RunResult
from .review import read_ratings, write_review


class RebuildError(ValueError):
    pass


def rebuild_review(storage: Storage, run_id: str) -> dict[str, int]:
    """Rewrites `review.md` and returns the selected segments per category (numbers only)."""
    result_path = run_file(storage, run_id, "result.json")
    transcript_path = run_file(storage, run_id, "transcript.json")
    review_path = run_file(storage, run_id, "review.md")
    temporary = run_file(storage, run_id, "review.md.tmp")
    if not result_path.is_file() or not transcript_path.is_file():
        raise RebuildError(f"{run_id}: this run has no saved transcript to review.")
    result = RunResult.model_validate(json.loads(result_path.read_text(encoding="utf-8")))
    if result.boundaries is None or result.review is None:
        raise RebuildError(f"{run_id}: this run has no saved transcript to review.")
    if review_path.is_file() and read_ratings(review_path)["rated"]:
        raise RebuildError(f"{run_id}: review.md already has ratings; it was left unchanged.")
    parsed = parse_transcript(json.loads(transcript_path.read_text(encoding="utf-8")))
    if not parsed.ok or parsed.data is None:
        raise RebuildError(f"{run_id}: transcript.json is not a valid transcript.")
    cuts: list[tuple[int, CutKind]] = []
    for row in result.boundaries["cuts"]:
        kind = row["kind"]
        if kind not in ("forced", "silence"):
            raise RebuildError(f"{run_id}: result.json has an unknown cut kind.")
        cuts.append((int(row["cutMs"]), kind))
    picks = select_for_review(cuts, parsed.data, seed=int(result.review["seed"]))
    write_review(
        temporary,
        label=result.clip.label,
        run_id=run_id,
        audio=run_file(storage, run_id, "normalized.wav"),
        picks=picks,
    )
    make_private(temporary)
    os.replace(temporary, review_path)
    return category_counts(picks)
