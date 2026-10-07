"""
Translation settings from the worker's environment. The API key is held in `SecretKey`, which
never prints its value; error messages here never repeat any translation variable's value.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass

from ..errors import ConfigError

PROVIDER_VAR = "PEBBLE_TRANSLATION_PROVIDER"
KEY_VAR = "DEEPL_AUTH_KEY"
REQUEST_LIMIT_VAR = "PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT"
CHARACTER_LIMIT_VAR = "PEBBLE_TRANSLATION_MONTHLY_CHARACTER_LIMIT"

DEFAULT_REQUEST_LIMIT = 300
DEFAULT_CHARACTER_LIMIT = 30_000
#: Upper bound for either limit, to catch typos (e.g. an extra digit or three).
MAX_LIMIT = 1_000_000_000
MAX_KEY_LENGTH = 512

_DIGITS = re.compile(r"[0-9]+")


class SecretKey:
    """An API key that never appears in repr, str, format or equality output."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        """Only for the Authorization header of a request to the fixed DeepL host."""
        return self._value

    def __repr__(self) -> str:
        return "SecretKey('***')"

    __str__ = __repr__

    def __format__(self, spec: str) -> str:
        return repr(self)

    def __reduce__(self) -> object:
        raise TypeError("SecretKey can't be pickled or copied")


@dataclass(frozen=True)
class TranslationSettings:
    """
    Off unless `provider` is "deepl"; then `auth_key` is always set. `key_missing`: the
    provider was asked for without a key, so translation is off (and the worker says so).
    """

    provider: str | None = None
    auth_key: SecretKey | None = None
    monthly_request_limit: int = DEFAULT_REQUEST_LIMIT
    monthly_character_limit: int = DEFAULT_CHARACTER_LIMIT
    key_missing: bool = False

    def __post_init__(self) -> None:
        if self.provider not in (None, "deepl"):
            raise ConfigError(f"{PROVIDER_VAR} must be unset or deepl.")
        if (self.provider is None) != (self.auth_key is None):
            raise ConfigError(f"{PROVIDER_VAR}=deepl and {KEY_VAR} must be set together.")
        for name, value in (
            (REQUEST_LIMIT_VAR, self.monthly_request_limit),
            (CHARACTER_LIMIT_VAR, self.monthly_character_limit),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_LIMIT:
                raise ConfigError(f"{name} must be a whole number from 1 to {MAX_LIMIT}.")

    @property
    def configured(self) -> bool:
        return self.provider is not None

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> TranslationSettings:
        raw_provider = (env.get(PROVIDER_VAR) or "").strip()
        if raw_provider and raw_provider.lower() != "deepl":
            # Never echo the value: a misplaced key must not end up in a startup message.
            raise ConfigError(f"{PROVIDER_VAR} must be unset or deepl.")
        provider = "deepl" if raw_provider else None
        key = None
        key_missing = False
        if provider:
            raw_key = env.get(KEY_VAR) or ""
            if not raw_key:
                # Transcription must keep working: translation is simply off.
                provider, key_missing = None, True
            elif len(raw_key) > MAX_KEY_LENGTH or any(c.isspace() or ord(c) < 32 for c in raw_key):
                raise ConfigError(
                    f"{KEY_VAR} isn't usable: it must be one line with no spaces, at most "
                    f"{MAX_KEY_LENGTH} characters."
                )
            else:
                key = SecretKey(raw_key)
        return cls(
            provider=provider,
            auth_key=key,
            key_missing=key_missing,
            monthly_request_limit=_limit(env, REQUEST_LIMIT_VAR, DEFAULT_REQUEST_LIMIT),
            monthly_character_limit=_limit(env, CHARACTER_LIMIT_VAR, DEFAULT_CHARACTER_LIMIT),
        )


def _limit(env: Mapping[str, str], name: str, default: int) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    if not _DIGITS.fullmatch(raw) or not 1 <= int(raw) <= MAX_LIMIT:
        raise ConfigError(f"{name} must be a whole number from 1 to {MAX_LIMIT}.")
    return int(raw)
