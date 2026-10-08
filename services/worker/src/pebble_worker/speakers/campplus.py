"""
The production adapters for the speaker core: the pinned CAM++ embedder and FunASR's installed
ClusterBackend (ADR 0009).

- Lazy: nothing heavy is imported until the first embedding. `state()` is cheap (file presence
  and sizes only) and never imports FunASR.
- Local only: the model loads from its verified folder under `<data>/models` with FunASR's update
  and hub checks off, and remote code is never trusted. Nothing here imports or calls ModelScope,
  so a run makes no network calls. (The worker can't block sockets process-wide, since DeepL
  translation shares the process.)
- Optional: a missing or unverified model is SPEAKER_MODEL_UNAVAILABLE for the speaker run only.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from ..models.manifest import CAMPPLUS_SV_ZH, ModelSpec
from ..models.verify import file_path, model_dir, verify_model
from ..storage import PRIVATE_DIR, Storage, make_private
from .core import SpeakerRunError

log = logging.getLogger("pebble.speakers")

PULL_HINT = "Download the speaker model with: npm run worker:models -- pull --speaker"
MERGE_THRESHOLD = 0.78  # FunASR's ClusterBackend default
CLUSTER_SEED = 7  # fixed, so the same episode clusters the same way

ModelState = Literal["ready", "missing", "incomplete"]
#: Loads the model from a verified local folder; returns windows → (n, dim) embeddings.
Loader = Callable[[Path], Callable[[list[Any]], Any]]


class CampplusEmbedder:
    def __init__(
        self, storage: Storage, *, spec: ModelSpec = CAMPPLUS_SV_ZH, loader: Loader | None = None
    ) -> None:
        self.storage = storage
        self.spec = spec
        self._loader = loader or _load_campplus
        self._lock = threading.Lock()
        self._embed: Callable[[list[Any]], Any] | None = None

    def state(self) -> ModelState:
        """Presence and sizes only (no hashing, no imports): for health and before queueing."""
        present = [file_path(self.storage, self.spec, f) for f in self.spec.files]
        if not any(path.is_file() for path in present):
            return "missing"
        if all(
            path.is_file() and path.stat().st_size == f.size
            for path, f in zip(present, self.spec.files, strict=True)
        ):
            return "ready"
        return "incomplete"

    def __call__(self, windows: list[Any]) -> Any:
        return self._ensure_loaded()(windows)

    def _ensure_loaded(self) -> Callable[[list[Any]], Any]:
        with self._lock:
            if self._embed is not None:
                return self._embed
            if not verify_model(self.storage, self.spec).passed:
                raise SpeakerRunError(
                    "SPEAKER_MODEL_UNAVAILABLE",
                    f"The speaker model is missing or failed verification. {PULL_HINT}",
                )
            try:
                self._embed = self._loader(model_dir(self.storage, self.spec))
            except Exception as error:
                log.error("speaker model failed to load: %s", type(error).__name__)
                raise SpeakerRunError(
                    "SPEAKER_MODEL_UNAVAILABLE", "The speaker model couldn't be loaded."
                ) from error
            log.info("speaker model loaded (CPU)")
            return self._embed


def _load_campplus(directory: Path) -> Callable[[list[Any]], Any]:
    import numpy
    import torch
    from funasr import AutoModel
    from funasr.models.campplus.utils import extract_feature

    auto = AutoModel(
        model=str(directory),
        device="cpu",
        disable_update=True,  # no PyPI version check
        check_latest=False,  # never ask the hub about a local model
        disable_pbar=True,
        trust_remote_code=False,
    )
    model = auto.model
    model.eval()

    def embed(windows: list[Any]) -> Any:
        with torch.no_grad():
            feats, _, _ = extract_feature([torch.from_numpy(w) for w in windows])
            return model(feats.to(torch.float32)).cpu().numpy().astype(numpy.float32)

    return embed


class FunasrClusterer:
    """
    FunASR's installed ClusterBackend, seeded, recording the branch that actually ran.

    `cache_dir` is where numba (used by UMAP/pynndescent with `cache=True`) may write compiled
    functions: the child's run-local scratch folder, removed after every run. There is no
    permanent cache.
    """

    def __init__(
        self, cache_dir: Path, *, seed: int = CLUSTER_SEED, speaker_count: int | None = None
    ) -> None:
        self.cache_dir = cache_dir
        self.seed = seed
        self.speaker_count = speaker_count  # the learner's hint, or None (automatic)

    def __call__(self, embeddings: Any) -> tuple[list[int], str]:
        self.cache_dir.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR)
        make_private(self.cache_dir)
        # Read by numba when it is first imported (UMAP imports it lazily).
        os.environ["NUMBA_CACHE_DIR"] = str(self.cache_dir)
        import numpy
        from funasr.models.campplus.cluster_backend import ClusterBackend

        numpy.random.seed(self.seed)
        backend = ClusterBackend(merge_thr=MERGE_THRESHOLD)
        observed: list[str] = []
        for name, attribute in (
            ("spectral", "spectral_cluster"),
            ("umap-hdbscan", "umap_hdbscan_cluster"),
            ("kmeans", "kmeans_cluster"),
        ):
            inner = getattr(backend, attribute)

            def wrapped(*args: Any, _inner: Any = inner, _name: str = name, **kw: Any) -> Any:
                observed.append(_name)
                return _inner(*args, **kw)

            setattr(backend, attribute, wrapped)
        labels = backend(embeddings, oracle_num=self.speaker_count)
        return [int(label) for label in labels], (observed[0] if observed else "single")
