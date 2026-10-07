"""
Optional DeepL line translation (ADR 0008, docs/TRANSLATION.md).

Built in slices. So far: configuration, storage, consent and the health block. Nothing here
makes a network call, and translation requests aren't implemented yet, so `/health` doesn't
report translation (see `REQUESTS_IMPLEMENTED`).
"""

from __future__ import annotations

#: False until POST /translations exists. While False, /health omits `translation`: a
#: configured worker with current consent would otherwise have to claim new requests are
#: "available", which isn't true yet.
REQUESTS_IMPLEMENTED = False
