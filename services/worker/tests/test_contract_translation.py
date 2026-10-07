"""Translation payloads (contract 1.8): the Pydantic half must agree with lineTranslation.ts."""

from __future__ import annotations

import json

import pytest
from conftest import EXAMPLES

from pebble_worker.contract import (
    CURRENT_SCHEMA_VERSION,
    EpisodeTranslations,
    TranslationConsent,
    TranslationConsentRequest,
    TranslationHealth,
    TranslationRequest,
    TranslationResult,
    parse_episode_translations,
    parse_translation_consent,
    parse_translation_consent_request,
    parse_translation_request,
    parse_translation_result,
    parse_worker_health,
    translation_availability,
    translation_text_problem,
)

TEXT_CASES = json.loads((EXAMPLES / "translation-text.json").read_text())["cases"]


def load(name: str) -> dict:
    return json.loads((EXAMPLES / name).read_text())


# --- Shared text rules ----------------------------------------------------------------------


@pytest.mark.parametrize("case", TEXT_CASES, ids=lambda c: c["name"])
def test_shared_text_cases(case):
    assert translation_text_problem(case["text"]) == case["reason"]


def test_code_points_not_utf16_units():
    astral = "\U00020bb7" * 300
    assert len(astral.encode("utf-16-le")) // 2 == 600
    assert translation_text_problem(astral) is None


def test_text_is_kept_exactly_as_submitted():
    text = "  他说 OK 吧。 "
    result = parse_translation_request(
        {"schemaVersion": "1.8", "episodeId": "example-001", "segmentId": "seg-0001", "text": text}
    )
    assert result.ok and result.data.text == text


# --- Health ---------------------------------------------------------------------------------

LIMITS = {
    "period": "2026-10",
    "requestsUsed": 0,
    "requestLimit": 300,
    "charactersUsed": 0,
    "characterLimit": 30000,
}


def health(**overrides):
    payload = load("valid/worker-health-translation.json")
    payload["translation"] = {
        "provider": "deepl",
        "configured": True,
        "consent": "current",
        "consentVersion": "deepl-2026-10",
        "newRequests": "available",
        "limits": dict(LIMITS),
        **overrides,
    }
    return payload


@pytest.mark.parametrize(
    "overrides",
    [
        {"configured": False, "consent": "not_configured", "newRequests": "off"},
        {"consent": "required", "newRequests": "consent_required"},
        {},
        {"newRequests": "local_limit_reached", "limits": {**LIMITS, "requestsUsed": 300}},
        {"newRequests": "local_limit_reached", "limits": {**LIMITS, "charactersUsed": 30000}},
        {"newRequests": "local_limit_reached", "limits": {**LIMITS, "requestsUsed": 301}},
        {
            "consent": "required",
            "newRequests": "consent_required",
            "limits": {**LIMITS, "requestsUsed": 300},
        },
    ],
    ids=[
        "not configured",
        "needs consent",
        "ready",
        "request limit reached",
        "character limit reached",
        "usage above a lowered limit",
        "needs consent even at the limit",
    ],
)
def test_valid_readiness(overrides):
    result = parse_worker_health(health(**overrides))
    assert result.ok, result.issues


@pytest.mark.parametrize(
    ("overrides", "path"),
    [
        ({"configured": False, "consent": "not_configured"}, "translation.newRequests"),
        ({"configured": False, "newRequests": "off"}, "translation.consent"),
        ({"consent": "not_configured"}, "translation.consent"),
        ({"consent": "required"}, "translation.newRequests"),
        ({"newRequests": "off"}, "translation.newRequests"),
        ({"limits": {**LIMITS, "requestsUsed": 300}}, "translation.newRequests"),
        ({"newRequests": "local_limit_reached"}, "translation.newRequests"),
        ({"provider": "other"}, "translation.provider"),
        ({"limits": {**LIMITS, "period": "2026-13"}}, "translation.limits.period"),
        ({"limits": {**LIMITS, "requestLimit": 0}}, "translation.limits.requestLimit"),
        ({"consentVersion": "Bad Version"}, "translation.consentVersion"),
    ],
    ids=[
        "off but available",
        "not configured but consent current",
        "configured without a consent state",
        "consent required but available",
        "ready reported as off",
        "available at the limit",
        "limit reached below the limit",
        "unknown provider",
        "bad period",
        "zero limit",
        "bad consent version",
    ],
)
def test_contradictory_or_invalid_readiness(overrides, path):
    result = parse_worker_health(health(**overrides))
    assert not result.ok
    assert path in [issue.path for issue in result.issues], result.issues


@pytest.mark.parametrize("name", ["worker-health.json", "worker-health-instance.json"])
def test_older_health_without_translation_means_off(name):
    result = parse_worker_health(load(f"valid/{name}"))
    assert result.ok and result.data.translation is None
    assert translation_availability(result.data.translation) == (False, "off")
    assert "translation" not in result.data.dump()


def test_the_worker_advertises_1_8_now_that_translation_routes_exist():
    assert CURRENT_SCHEMA_VERSION == "1.8"


# --- Malformed payloads ---------------------------------------------------------------------

RESULT = {
    "schemaVersion": "1.8",
    "episodeId": "example-001",
    "segmentId": "seg-0001",
    "fingerprint": "a" * 64,
    "provider": "deepl",
    "targetLanguage": "EN-US",
    "text": "Invented English.",
    "source": "provider",
    "createdAt": "2026-10-06T12:00:00Z",
}
REQUEST = {"schemaVersion": "1.8", "episodeId": "example-001", "segmentId": "seg-0001"}
CONSENT = {"schemaVersion": "1.8", "provider": "deepl", "consentVersion": "deepl-2026-10"}


@pytest.mark.parametrize(
    ("parse", "payload"),
    [
        (parse_translation_request, REQUEST),
        (parse_translation_request, {**REQUEST, "text": 5}),
        (parse_translation_request, {**REQUEST, "segmentId": "", "text": "好"}),
        (parse_translation_request, {**REQUEST, "episodeId": "Episode 1", "text": "好"}),
        (parse_translation_result, {**RESULT, "fingerprint": "A" * 64}),
        (parse_translation_result, {**RESULT, "fingerprint": "a" * 63}),
        (parse_translation_result, {**RESULT, "targetLanguage": "EN-GB"}),
        (parse_translation_result, {**RESULT, "source": "browser"}),
        (parse_translation_result, {**RESULT, "text": "a" * 2001}),
        (parse_translation_result, {**RESULT, "text": "Invented\x00English."}),
        (parse_translation_result, {**RESULT, "text": "Invented \ud800"}),
        (
            parse_episode_translations,
            {
                "schemaVersion": "1.8",
                "episodeId": "example-001",
                "provider": "deepl",
                "targetLanguage": "EN-US",
                "cacheVersion": 2,
                "translations": [],
            },
        ),
        (parse_translation_consent_request, {"schemaVersion": "1.8", "provider": "deepl"}),
        (
            parse_translation_consent,
            {**CONSENT, "status": "required", "grantedAt": "2026-10-06T12:00:00Z"},
        ),
        (parse_translation_consent, {**CONSENT, "status": "withdrawn", "grantedAt": None}),
    ],
    ids=[
        "request without text",
        "request with numeric text",
        "request with an empty segment id",
        "request with a bad episode id",
        "result with an uppercase fingerprint",
        "result with a short fingerprint",
        "result with another target language",
        "result with an unknown source",
        "result with too much text",
        "result with a control character",
        "result with an unpaired surrogate",
        "cache with another cache version",
        "consent request without a version",
        "consent required with a grant time",
        "consent with an unknown status",
    ],
)
def test_malformed_payloads(parse, payload):
    assert not parse(payload).ok


def test_whitespace_inside_a_translation_is_allowed():
    assert parse_translation_result({**RESULT, "text": "Invented,\tEnglish."}).ok


# --- No key or raw provider error ---------------------------------------------------------

FORBIDDEN = ("key", "auth", "secret", "token", "raw", "providermessage", "providererror", "detail")


@pytest.mark.parametrize(
    "model",
    [
        TranslationHealth,
        TranslationRequest,
        TranslationResult,
        EpisodeTranslations,
        TranslationConsentRequest,
        TranslationConsent,
    ],
    ids=lambda m: m.__name__,
)
def test_public_shapes_declare_no_key_or_raw_error_field(model):
    for name in model.model_fields:
        assert not any(word in name.replace("_", "").lower() for word in FORBIDDEN), name


def test_such_fields_are_dropped_if_present():
    result = parse_translation_result(
        {
            **RESULT,
            "authKey": "invented-not-a-key",
            "providerMessage": "invented provider text",
            "raw": {"anything": True},
        }
    )
    assert result.ok
    dumped = result.data.dump()
    assert not {"authKey", "providerMessage", "raw"} & dumped.keys()


# --- schemaVersion on requests (same rule as every payload) ---------------------------------

BODY = {"episodeId": "example-001", "segmentId": "seg-0001", "text": "好"}


@pytest.mark.parametrize("version", ["1.7", "1.8", "1.9"])
def test_request_accepts_any_1x(version):
    assert parse_translation_request({**BODY, "schemaVersion": version}).ok


@pytest.mark.parametrize(
    ("version", "code"),
    [
        (None, "INVALID_PAYLOAD"),
        (1.8, "INVALID_PAYLOAD"),
        ("1.8.0", "INVALID_PAYLOAD"),
        ("2.0", "UNSUPPORTED_VERSION"),
    ],
    ids=["missing", "not a string", "malformed", "another major"],
)
def test_request_rejects_bad_versions(version, code):
    payload = dict(BODY) if version is None else {**BODY, "schemaVersion": version}
    result = parse_translation_request(payload)
    assert not result.ok and result.code == code
