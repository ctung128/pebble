# Speech models

Pebble's local transcription (M1) uses three pretrained models run by the
[FunASR](https://github.com/modelscope/FunASR) toolkit, on this computer, on the CPU. This page
records exactly which weights those are, where they come from, under what license, and how
they are downloaded, verified and removed.

> [!IMPORTANT]
> **Status: M1-A.** The packages and model tooling exist. The FunASR provider is **not
> connected yet**: local transcripts are still mock placeholder text
> ([LOCAL_MODE.md](LOCAL_MODE.md)). No model has been downloaded as part of the repository,
> and none ever will be.

## Source of truth

The manifest in
[`services/worker/src/pebble_worker/models/manifest.py`](../services/worker/src/pebble_worker/models/manifest.py)
is the only place a model is chosen. Each entry pins a **full model ID at an exact tag** and
records the byte size and SHA-256 of every runtime file. There is no floating "latest"
reference anywhere: no `master`, no unpinned alias such as `paraformer-zh`. Changing a model
means changing the manifest, its tests and this page together.

## Scope (M1-A)

Approved — exactly these three checkpoints:

- `iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch` at revision
  `v2.0.9`
- `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` at revision `v2.0.4`
- `iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch` at revision `v2.0.4`

Not approved:

- the larger Chinese-English punctuation model
  (`iic/punc_ct-transformer_cn-en-common-vocab471067-large`)
- any other FunASR model
- speaker diarization
- MPS support or configuration (the worker is CPU-only)
- cloud or API transcription
- a translation provider
- model weights in Git, the public demo, or any deployment artifact

## Selected models

| Role                 | Model ID (ModelScope)                                                          | Revision | Runtime files | Size (bytes)  |
| -------------------- | ------------------------------------------------------------------------------ | -------- | ------------- | ------------- |
| Speech (ASR)         | `iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch` | `v2.0.9` | 6             | 998,159,710   |
| Voice activity (VAD) | `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch`                                 | `v2.0.4` | 4             | 1,730,986     |
| Punctuation          | `iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch`                     | `v2.0.4` | 4             | 296,188,555   |
| **Total**            |                                                                                |          | 14            | 1,296,079,251 |

Model cards:

- <https://modelscope.cn/models/iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch>
- <https://modelscope.cn/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch>
- <https://modelscope.cn/models/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch>

Main weight files (`model.pt`) — every runtime file's hash is in the manifest:

| Model       | `model.pt` SHA-256                                                 |
| ----------- | ------------------------------------------------------------------ |
| ASR         | `3d491689244ec5dfbf9170ef3827c358aa10f1f20e42a7c59e15e688647946d1` |
| VAD         | `b3be75be477f0780277f3bae0fe489f48718f585f3a6e45d7dd1fbb1a4255fc5` |
| Punctuation | `a5818bb9d933805a916eebe41eb41648f7f9caad30b4bd59d56f3ca135421916` |

Runtime files are exactly the ones each model's `configuration.json` references (`model.pt`,
`config.yaml`, plus `tokens.json`, `seg_dict` and `am.mvn` where applicable) and
`configuration.json` itself. Example audio, figures and READMEs are not downloaded. Sizes and
hashes were read from the ModelScope file API for each pinned tag on 2026-10-03. At those
tags, `model.pt` is byte-identical to the repositories' current `master`.

The ASR alias `paraformer-zh` in FunASR resolves to the **SeACo**-Paraformer checkpoint above.
For punctuation, Pebble uses the smaller Mandarin-only model rather than FunASR's default
Chinese–English `ct-punc` (`iic/punc_ct-transformer_cn-en-common-vocab471067-large`, 1.19 GB);
the larger model is not downloaded in M1-A. Diarization, language-model and LLM-based FunASR
models are not used.

## Licenses

- **FunASR toolkit** (`funasr==1.4.16`): MIT.
- **Model weights:** each selected model card's metadata reports **Apache License 2.0** at the
  pinned tag. The selected cards do **not** link the FunASR Model Open Source License, and the
  repositories contain no separate license file, so Pebble records **Apache-2.0** as the
  applicable license for these exact checkpoints. This is a per-checkpoint finding, not a rule
  for FunASR models in general: check the card of any other model before using it.

### Attribution

Keep the full original model names and their provenance wherever the models are credited:

- _speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch_
  (SeACo-Paraformer large, Mandarin, 16 kHz) by Alibaba Tongyi Lab, published by the `iic`
  organization on ModelScope. Apache-2.0.
- _speech_fsmn_vad_zh-cn-16k-common-pytorch_ (FSMN voice activity detection, 16 kHz) by
  Alibaba Tongyi Lab, published by the `iic` organization on ModelScope. Apache-2.0.
- _punc_ct-transformer_zh-cn-common-vocab272727-pytorch_ (CT-Transformer punctuation,
  Mandarin) by Alibaba Tongyi Lab, published by the `iic` organization on ModelScope.
  Apache-2.0.
- Run with FunASR (MIT).

`pebble-worker models list` prints the same attribution from the manifest.

## Weights are local-only

Model weights are **never committed, bundled or served**. They are not in this repository, not
in the public demo build (which runs with no models, worker, Python or keys), and the worker's
HTTP API has no route that serves them. They exist only in your Pebble data directory, after
you run `models pull` yourself.

## Install, download, verify

From the repository root. The FunASR packages are an optional extra of the worker; the mock
worker and its tests do not need them.

```bash
# 1. Packages (~231 MB download, ~0.9 GB installed) into services/worker/.venv
cd services/worker && UV_CACHE_DIR=~/.pebble/uv-cache uv sync --extra funasr && cd ../..

# 2. Inspect, download and check the pinned models (~1.30 GB)
npm run worker:models -- list     # manifest, locations, what is on disk (offline)
npm run worker:models -- pull     # the only command that contacts a model hub
npm run worker:models -- verify   # offline; exit code 0 only if every file passes
```

The same commands are available as `uv run --project services/worker pebble-worker models
list|pull|verify`.

- **`list`** prints each model's role, ID, revision, card URL, license, attribution, expected
  size, location and how many of its files are present. It does not hash or download.
- **`verify`** checks every runtime file at its **exact manifest path** (no globs). For each
  file it prints the expected and actual SHA-256 and byte size and a separate **PASS**,
  **FAIL** or **MISSING** status. Symlinks — on the file or any directory between it and the
  data directory — fail, as does any path resolving outside `PEBBLE_DATA_DIR`. It exits
  non-zero unless every file passes.
- **`pull`** downloads each pinned tag from ModelScope (`modelscope.cn`), fetching only the
  manifest's runtime files, makes the files private (`0600`/`0700`), and then runs `verify`.
  Models that already verify are skipped without contacting the hub. It exits non-zero if
  anything fails verification.

### No network outside `models pull`

Starting the worker, `doctor`, `models list` and `models verify` make no network calls and do
not import FunASR, ModelScope or PyTorch. This is tested with all sockets blocked
(`services/worker/tests/test_funasr_env.py`). When the FunASR provider is built, it will load
models from their local directories with FunASR's update check disabled, so normal
transcription stays offline too.

## Where things go, and how to remove them

| Location                        | What                                       | Set by                    |
| ------------------------------- | ------------------------------------------ | ------------------------- |
| `~/.pebble/models/iic/<name>/`  | Model files                                | `models pull`             |
| `~/.pebble/models/.modelscope/` | ModelScope's settings/session directory    | `MODELSCOPE_HOME` (pull)  |
| `~/.pebble/models/`             | ModelScope cache root                      | `MODELSCOPE_CACHE` (pull) |
| `~/.pebble/uv-cache/`           | uv's package download cache for the worker | `UV_CACHE_DIR`            |
| `services/worker/.venv/`        | The worker's isolated Python environment   | `uv sync` / `uv run`      |

`models pull` sets `MODELSCOPE_CACHE` and `MODELSCOPE_HOME` itself: without
`MODELSCOPE_HOME`, ModelScope writes a session identifier to `~/.modelscope/credentials/`.
The npm worker scripts set `UV_CACHE_DIR`; set it yourself when you call `uv` directly. (With
a custom `PEBBLE_DATA_DIR`, models follow the data directory; the uv cache stays at
`~/.pebble/uv-cache`.)

Cleanup:

```bash
rm -rf ~/.pebble                 # audio, chunks, database, logs, models, ModelScope state,
                                 # benchmark artifacts and the uv cache
rm -rf services/worker/.venv     # the isolated worker Python environment
```

Packages uv downloaded **before** M1-A (the worker's base dependencies, in M0C) are in uv's
default cache (`~/.cache/uv`), which Pebble does not manage; `uv cache clean` empties it.

## Compatibility notes (M1-A)

- `torch==2.11.0` and `torchaudio==2.11.0` are pinned as a matched pair. torchaudio's metadata
  does not pin torch, so the pairing is deliberate. CPU only; MPS is not configured.
- `transformers` is **not** a direct dependency. `funasr` declares it with no version bound, so
  the worker constrains it to `>=4.32.0,<5` (`[tool.uv] constraint-dependencies`), which locks
  4.57.6 with `huggingface-hub` 0.36.2 and `tokenizers` 0.22.2 — all prebuilt wheels. Without
  the constraint, uv resolves transformers 4.12.2 or even 2.3.0, which need a Rust source
  build.
- FunASR imports transformers during package initialization because optional FunASR modules use it. Pebble's selected Paraformer, FSMN-VAD, and ct-punc-c paths do not require Transformers model features at runtime. Pebble lets FunASR import it normally and does not block or patch it; the
  approximately two seconds this adds is a one-time cost when the provider is first loaded.
  (Concretely: FunASR's package `__init__` imports every submodule, and optional modules such
  as `models/fun_asr_nano/model.py` run `try: from transformers import …`. As a diagnostic
  only, `check_funasr_env.py funasr-without-transformers` shows the selected modules still
  import and register with transformers unavailable.)
- Importing `funasr` records import errors for unrelated optional modules (missing `whisper`,
  `einops`, `pytorch_wpe`, `triton`, and some legacy training modules). They do not affect the
  selected models. `services/worker/scripts/check_funasr_env.py` reports all of them, and
  `tests/test_funasr_env.py` checks that the selected models' modules have none.
