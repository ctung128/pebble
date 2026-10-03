"""The Pydantic models must agree with the Zod schemas on every shared example."""

from __future__ import annotations

import json
import re

import pytest
from conftest import EXAMPLES

from pebble_worker.contract import (
    Transcript,
    TranscriptProvenance,
    parse_job,
    parse_manifest,
    parse_transcript,
    parse_worker_health,
)

PARSERS = {
    "manifest": parse_manifest,
    "transcript": parse_transcript,
    "job": parse_job,
    "worker-health": parse_worker_health,
}
#: Browser-only payloads the worker never reads or writes.
BROWSER_ONLY = {"demo-translations", "illustrative-uncertainty", "correction", "learning-item"}
EXPECTATIONS = json.loads((EXAMPLES / "expectations.json").read_text())["invalid"]


def parser_for(name: str):
    for prefix, parse in PARSERS.items():
        if name.startswith(prefix):
            return parse
    assert any(name.startswith(p) for p in BROWSER_ONLY), f"no parser decision for {name}"
    return None


def load(path):
    return json.loads(path.read_text())


VALID = sorted((EXAMPLES / "valid").glob("*.json"))
INVALID = sorted((EXAMPLES / "invalid").glob("*.json"))


def test_every_invalid_example_has_a_shared_expectation():
    assert sorted(p.name for p in INVALID) == sorted(EXPECTATIONS)


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_valid_examples(path):
    parse = parser_for(path.name)
    if parse is None:
        pytest.skip("browser-only payload")
    result = parse(load(path))
    assert result.ok, result.issues


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_invalid_examples_match_zod(path):
    parse = parser_for(path.name)
    if parse is None:
        pytest.skip("browser-only payload")
    expected = EXPECTATIONS[path.name]
    result = parse(load(path))
    assert not result.ok
    assert result.code == expected["code"]
    assert any(
        issue.path == expected["path"] and re.search(expected["message"], issue.message)
        for issue in result.issues
    ), result.issues


def test_unknown_fields_are_ignored():
    payload = load(EXAMPLES / "valid" / "transcript.json")
    assert "futureField" in payload
    assert parse_transcript(payload).ok


def test_strict_types_reject_numeric_strings():
    payload = load(EXAMPLES / "valid" / "transcript.json")
    payload["durationMs"] = "9000"
    result = parse_transcript(payload)
    assert not result.ok and result.issues[0].path == "durationMs"


def test_optional_fields_are_omitted_not_null():
    payload = load(EXAMPLES / "valid" / "transcript-mock.json")
    transcript = Transcript.model_validate(payload)
    without_notes = transcript.provenance.model_copy(update={"notes": None})
    assert "notes" not in without_notes.dump()
    assert TranscriptProvenance.model_validate(without_notes.dump()).notes is None
    assert transcript.dump()["provenance"]["kind"] == "mock"
