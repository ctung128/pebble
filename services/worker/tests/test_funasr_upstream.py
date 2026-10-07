"""
FunASR 1.4.16 compatibility: why Pebble builds lines from recognition units (ADR 0007).

Runs FunASR's own sentence helpers on invented input: no model, audio or network. They run
in a child process so importing FunASR (and torch/ModelScope) can't leak into other tests. Skipped
when the `funasr` extra isn't installed, and for any other FunASR version, because these
tests pin 1.4.16's behaviour on purpose. After a FunASR upgrade: run them by hand against
the new version, update the expectations (the VAD-join drift may be fixed upstream), then
update the pinned version here, in ADR 0007 and in docs/MODELS.md.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import subprocess
import sys

import pytest

from pebble_worker.providers.funasr import normalize_output

PINNED = "1.4.16"

if importlib.util.find_spec("funasr") is None:
    pytest.skip("the funasr extra is not installed", allow_module_level=True)
if importlib.metadata.version("funasr") != PINNED:
    pytest.skip(
        f"pinned to FunASR {PINNED}; re-check the VAD-join drift by hand, then update these "
        "tests, ADR 0007 and docs/MODELS.md for the new version",
        allow_module_level=True,
    )

UPSTREAM = """
import json, logging, sys
logging.disable(logging.CRITICAL)
from funasr.auto.auto_model import _join_vad_texts
from funasr.utils.timestamp_tools import timestamp_sentence
vad_texts, pairs, punc_ids = json.load(sys.stdin)
joined = _join_vad_texts(vad_texts)
json.dump([joined, timestamp_sentence(punc_ids, pairs, joined)], sys.stdout)
"""


def upstream(vad_texts, pairs, punc_ids):
    """FunASR 1.4.16's `_join_vad_texts` and `timestamp_sentence`, in a child process."""
    done = subprocess.run(
        [sys.executable, "-I", "-c", UPSTREAM],
        input=json.dumps([vad_texts, pairs, punc_ids]),
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    joined, sentences = json.loads(done.stdout)
    return joined, sentences


CHUNK_MS = 30_000
#: CT-Transformer punctuation ids: 1 none, 2 comma, 3 full stop, 4 question mark.
MARKS = {2: "，", 3: "。", 4: "\uff1f"}


def funasr_output(vad_texts, pairs, punc_ids):
    """What FunASR 1.4.16's VAD path builds from these per-VAD results (no models)."""
    # `joined` is the text it punctuates and splits into sentences
    joined, sentences = upstream(vad_texts, [list(p) for p in pairs], punc_ids)
    units = " ".join(vad_texts).split()  # its raw_text: VAD texts joined with a space
    chars = [c for unit in units for c in unit]
    assert len(chars) == len(punc_ids)  # CT-Transformer marks every character
    text = "".join(c + MARKS.get(p, "") for c, p in zip(chars, punc_ids, strict=True))
    return joined, [
        {
            "key": "chunk",
            "text": text,
            "timestamp": [list(p) for p in pairs],
            "raw_text": " ".join(units),
            "sentence_info": sentences,
        }
    ]


def test_space_less_vad_join_makes_funasr_sentences_drift():
    pairs = [[0, 100], [100, 200], [200, 300], [1000, 1100], [1100, 1200]]
    joined, result = funasr_output(["甲 乙 丙", "丁 戊"], pairs, [1, 1, 3, 1, 3])
    assert len(joined.split()) == 4  # "丙丁" became one unit, but there are five pairs
    sentences = [(s["text"], s["start"], s["end"]) for s in result[0]["sentence_info"]]
    assert sentences == [("甲乙丙丁。", 0, 300), ("戊。", 1000, 1200)], (
        "FunASR's sentence text no longer drifts after a VAD join; if it is fixed upstream, "
        "revisit ADR 0007 before changing how Pebble builds lines"
    )


def test_several_joins_leave_a_timed_punctuation_only_tail_in_funasr():
    pairs = [[i * 100, i * 100 + 100] for i in range(8)]
    vad = ["甲 乙", "丙 丁", "戊 己", "庚 辛"]
    _, result = funasr_output(vad, pairs, [1, 3] * 4)
    assert [s["text"] for s in result[0]["sentence_info"]][-1] == "。"
    assert [s.text for s in normalize_output(result, CHUNK_MS)] == [
        "甲乙。",
        "丙丁。",
        "戊己。",
        "庚辛。",
    ]


def test_pebble_lines_follow_the_units_across_joins():
    pairs = [[0, 100], [100, 200], [200, 300], [1000, 1100], [1100, 1200]]
    _, result = funasr_output(["甲 乙 丙", "丁 戊"], pairs, [1, 1, 3, 1, 3])
    lines = [(s.start_ms, s.end_ms, s.text) for s in normalize_output(result, CHUNK_MS)]
    assert lines == [(0, 300, "甲乙丙。"), (1000, 1200, "丁戊。")]


@pytest.mark.parametrize(
    ("vad_texts", "punc_ids"),
    [
        (["今 天 天 气 很 好 我 们 去 公 园"], [1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 3]),
        (["你 好 吗 很 好"], [1, 1, 4, 1, 3]),
        (["一 二 三 四 五 六"], [1, 2, 1, 2, 1, 3]),
    ],
)
def test_single_vad_output_is_unchanged(vad_texts, punc_ids):
    # Without a join FunASR's sentences are right; Pebble's lines must equal them exactly.
    count = len(punc_ids)
    pairs = [[i * 150, i * 150 + 120] for i in range(count)]
    _, result = funasr_output(vad_texts, pairs, punc_ids)
    expected = [(s["start"], s["end"], s["text"]) for s in result[0]["sentence_info"]]
    lines = [(s.start_ms, s.end_ms, s.text) for s in normalize_output(result, CHUNK_MS)]
    assert lines == expected
