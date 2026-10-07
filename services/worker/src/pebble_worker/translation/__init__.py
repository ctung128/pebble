"""
Optional DeepL line translation (ADR 0008, docs/TRANSLATION.md).

Worker side: configuration, storage, consent, the health block, the DeepL client and the
translation service. Only POST /translations may contact DeepL. The local app doesn't use any
of it yet.
"""

from __future__ import annotations

#: True now that POST /translations exists: /health reports `translation`. While it was False
#: (slice 3), a configured worker with current consent couldn't honestly report "available".
REQUESTS_IMPLEMENTED = True
