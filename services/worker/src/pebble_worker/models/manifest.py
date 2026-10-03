"""
The pinned model manifest: the single source of truth for which weights Pebble uses.

Every entry is an exact ModelScope model ID at an exact tag, with the size and SHA-256 of each
runtime file (the files the model's `configuration.json` references, plus that file itself).
Never point an entry at a floating revision such as `master`. Sizes and hashes were read from the
ModelScope file API for the pinned tag on 2026-10-03; `pebble-worker models verify` checks them.

Weights live only under `<PEBBLE_DATA_DIR>/models`. They are never committed, bundled or served.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ModelRole = Literal["asr", "vad", "punctuation"]

#: Directory under the Pebble data directory that holds every downloaded model.
MODELS_DIRNAME = "models"
MODELSCOPE_HUB = "https://modelscope.cn"


@dataclass(frozen=True)
class ModelFile:
    path: str  # relative to the model directory
    size: int  # bytes
    sha256: str


@dataclass(frozen=True)
class ModelSpec:
    role: ModelRole
    model_id: str  # "<owner>/<name>" on ModelScope
    revision: str  # an exact tag, never a branch
    license: str  # SPDX identifier
    license_source: str
    attribution: str
    files: tuple[ModelFile, ...]
    total_size: int  # bytes; the sum of `files`

    @property
    def card_url(self) -> str:
        return f"{MODELSCOPE_HUB}/models/{self.model_id}"

    @property
    def relative_dir(self) -> str:
        """Where the model lives, relative to the models directory."""
        return self.model_id


_CARD_LICENSE = (
    "ModelScope model card metadata at the pinned tag: `license: Apache License 2.0`. "
    "The card does not link the FunASR Model Open Source License."
)

PARAFORMER = ModelSpec(
    role="asr",
    model_id="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    revision="v2.0.9",
    license="Apache-2.0",
    license_source=_CARD_LICENSE,
    attribution=(
        "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch "
        "(SeACo-Paraformer large, Mandarin, 16 kHz) by Alibaba Tongyi Lab, published by the "
        "iic organization on ModelScope. Licensed under Apache-2.0."
    ),
    files=(
        ModelFile(
            "configuration.json",
            478,
            "1acac324430b5a4680ef5ee2947575443ab2039a92c8a0551665f6bc9a606b41",
        ),
        ModelFile(
            "config.yaml", 3474, "8e77b1c260ace850da67fed908e8ecd4b90b1664a506b45c28c2a3e09fa7ba4e"
        ),
        ModelFile(
            "model.pt",
            989763045,
            "3d491689244ec5dfbf9170ef3827c358aa10f1f20e42a7c59e15e688647946d1",
        ),
        ModelFile(
            "tokens.json", 93676, "2b20c2b12572d682afff84ce1c8d560f67b8b32a4c1f21567411d141ed352127"
        ),
        ModelFile(
            "seg_dict", 8287834, "59a2ef803a3f1648ad03a2e1480db1c1ee0c0d7dc4ef4dbd16cea33944329022"
        ),
        ModelFile(
            "am.mvn", 11203, "29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5"
        ),
    ),
    total_size=998159710,
)

FSMN_VAD = ModelSpec(
    role="vad",
    model_id="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    revision="v2.0.4",
    license="Apache-2.0",
    license_source=_CARD_LICENSE,
    attribution=(
        "speech_fsmn_vad_zh-cn-16k-common-pytorch (FSMN voice activity detection, 16 kHz) by "
        "Alibaba Tongyi Lab, published by the iic organization on ModelScope. "
        "Licensed under Apache-2.0."
    ),
    files=(
        ModelFile(
            "configuration.json",
            365,
            "7bce8867e37d55c3dd8f672695ced18077a2be199ea529a5d432d5350fc0acba",
        ),
        ModelFile(
            "config.yaml", 1215, "486861ca26ddb79081663b6179cb204c6bfae71c52f04aafc48a9e9d8dde1e93"
        ),
        ModelFile(
            "model.pt", 1721366, "b3be75be477f0780277f3bae0fe489f48718f585f3a6e45d7dd1fbb1a4255fc5"
        ),
        ModelFile(
            "am.mvn", 8040, "6820fef9687708c4fc3fab2530179c8fcea6262daa25514380056cd8f6eb1754"
        ),
    ),
    total_size=1730986,
)

CT_PUNC_ZH = ModelSpec(
    role="punctuation",
    model_id="iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    revision="v2.0.4",
    license="Apache-2.0",
    license_source=_CARD_LICENSE,
    attribution=(
        "punc_ct-transformer_zh-cn-common-vocab272727-pytorch (CT-Transformer punctuation, "
        "Mandarin) by Alibaba Tongyi Lab, published by the iic organization on ModelScope. "
        "Licensed under Apache-2.0."
    ),
    files=(
        ModelFile(
            "configuration.json",
            373,
            "ebca5ff883e03585b2eec84ce80573f851658bdc61f2887db7d076afe6facd91",
        ),
        ModelFile(
            "config.yaml", 810, "a56ec10925b06fa976ad51af373396be2b13e1eb8dc62a5426b5adebaba7071d"
        ),
        ModelFile(
            "model.pt",
            291979892,
            "a5818bb9d933805a916eebe41eb41648f7f9caad30b4bd59d56f3ca135421916",
        ),
        ModelFile(
            "tokens.json",
            4207480,
            "c960ab87bccea4aa15cf49a59f71973c2c330b46668048cd8da253749ec71ee3",
        ),
    ),
    total_size=296188555,
)

MANIFEST: tuple[ModelSpec, ...] = (PARAFORMER, FSMN_VAD, CT_PUNC_ZH)
