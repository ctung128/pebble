"""The pinned model manifest and `pebble-worker models list|verify|pull` (no network, no models)."""

from __future__ import annotations

import hashlib
import os
import re
import sys

import pytest

from pebble_worker.cli import main
from pebble_worker.errors import StorageAccessError
from pebble_worker.models import commands
from pebble_worker.models.manifest import MANIFEST, ModelFile, ModelSpec
from pebble_worker.models.pull import hub_environment, modelscope_downloader, pull
from pebble_worker.models.verify import file_path, model_dir, verify_model
from pebble_worker.storage import Storage

SHA256 = re.compile(r"^[0-9a-f]{64}$")


# --- the real manifest ------------------------------------------------------------------------


def test_manifest_pins_exactly_the_approved_models():
    assert [(s.role, s.model_id, s.revision) for s in MANIFEST] == [
        (
            "asr",
            "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            "v2.0.9",
        ),
        ("vad", "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", "v2.0.4"),
        ("punctuation", "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch", "v2.0.4"),
    ]


@pytest.mark.parametrize("spec", MANIFEST, ids=lambda s: s.role)
def test_manifest_entries_are_complete_and_consistent(spec):
    assert re.fullmatch(r"v\d+\.\d+\.\d+", spec.revision), "pin an exact tag, never a branch"
    assert spec.card_url == f"https://modelscope.cn/models/{spec.model_id}"
    assert spec.license == "Apache-2.0"
    assert spec.model_id.split("/")[1] in spec.attribution, "keep the full original model name"
    assert "iic" in spec.attribution and "Alibaba" in spec.attribution
    paths = [f.path for f in spec.files]
    assert len(paths) == len(set(paths))
    assert {"configuration.json", "config.yaml", "model.pt"} <= set(paths)
    assert all(SHA256.match(f.sha256) and f.size > 0 for f in spec.files)
    assert spec.total_size == sum(f.size for f in spec.files)


def test_manifest_total_size():
    assert sum(s.total_size for s in MANIFEST) == 1_296_079_251


# --- fake models for verify/pull ----------------------------------------------------------------


def _fake_spec(contents: dict[str, bytes], model_id: str = "test/fake-model") -> ModelSpec:
    files = tuple(
        ModelFile(path, len(data), hashlib.sha256(data).hexdigest())
        for path, data in contents.items()
    )
    return ModelSpec(
        role="asr",
        model_id=model_id,
        revision="v1.0.0",
        license="Apache-2.0",
        license_source="test",
        attribution="fake-model by nobody (test fixture)",
        files=files,
        total_size=sum(f.size for f in files),
    )


CONTENTS = {"configuration.json": b"{}", "config.yaml": b"model: Fake\n", "model.pt": b"weights"}


@pytest.fixture
def storage(tmp_path):
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    return storage


def _install(storage: Storage, spec: ModelSpec, contents: dict[str, bytes]) -> None:
    for path, data in contents.items():
        target = model_dir(storage, spec) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def _status(report) -> dict[str, str]:
    return {r.file.path: r.status for r in report.files}


def test_verify_reports_every_file_as_missing_before_download(storage):
    spec = _fake_spec(CONTENTS)
    report = verify_model(storage, spec)
    assert _status(report) == dict.fromkeys(CONTENTS, "missing")
    assert not report.passed
    assert all(r.actual_sha256 is None for r in report.files)


def test_verify_passes_matching_files_with_actual_hashes(storage):
    spec = _fake_spec(CONTENTS)
    _install(storage, spec, CONTENTS)
    report = verify_model(storage, spec)
    assert report.passed
    for result in report.files:
        assert result.actual_sha256 == result.file.sha256
        assert result.actual_size == result.file.size


def test_verify_fails_wrong_content_and_wrong_size_separately(storage):
    spec = _fake_spec(CONTENTS)
    _install(storage, spec, {**CONTENTS, "model.pt": b"WEIGHTS", "config.yaml": b"tampered!"})
    results = {r.file.path: r for r in verify_model(storage, spec).files}
    assert results["configuration.json"].status == "pass"
    assert results["model.pt"].status == "fail"
    assert results["model.pt"].detail == "SHA-256 differs"
    assert results["config.yaml"].detail == "size differs, SHA-256 differs"


def test_verify_mixes_pass_fail_and_missing(storage):
    spec = _fake_spec(CONTENTS)
    _install(storage, spec, {"configuration.json": b"{}", "model.pt": b"nope"})
    assert _status(verify_model(storage, spec)) == {
        "configuration.json": "pass",
        "config.yaml": "missing",
        "model.pt": "fail",
    }


def test_verify_refuses_a_symlinked_file_even_if_its_content_matches(storage, tmp_path):
    spec = _fake_spec(CONTENTS)
    _install(storage, spec, {k: v for k, v in CONTENTS.items() if k != "model.pt"})
    outside = tmp_path / "model.pt"
    outside.write_bytes(CONTENTS["model.pt"])
    file_path(storage, spec, spec.files[2]).symlink_to(outside)
    result = verify_model(storage, spec).files[2]
    assert result.status == "fail"
    assert result.detail is not None and result.detail.startswith("symlink refused")
    assert result.actual_sha256 is None


def test_verify_refuses_a_symlinked_model_directory(storage, tmp_path):
    spec = _fake_spec(CONTENTS)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    for path, data in CONTENTS.items():
        (elsewhere / path).write_bytes(data)
    model_dir(storage, spec).parent.mkdir(parents=True)
    model_dir(storage, spec).symlink_to(elsewhere)
    report = verify_model(storage, spec)
    assert {r.status for r in report.files} == {"fail"}
    assert all("symlink refused" in (r.detail or "") for r in report.files)


def test_verify_refuses_a_symlinked_models_root(storage, tmp_path):
    spec = _fake_spec(CONTENTS)
    _install(Storage(tmp_path / "other"), spec, CONTENTS)
    (storage.root / "models").symlink_to(tmp_path / "other" / "models")
    assert {r.status for r in verify_model(storage, spec).files} == {"fail"}


@pytest.mark.parametrize("bad", ["../escape", "/etc/hosts", "a/../../b", "", "./x"])
def test_manifest_paths_cannot_escape_the_models_directory(storage, bad):
    spec = _fake_spec({"model.pt": b"x"})
    with pytest.raises(StorageAccessError):
        file_path(storage, spec, ModelFile(bad, 1, "0" * 64))
    with pytest.raises(StorageAccessError):
        model_dir(storage, _fake_spec({}, model_id=bad or "."))


def test_verify_never_hashes_files_outside_the_manifest(storage):
    spec = _fake_spec(CONTENTS)
    _install(storage, spec, {**CONTENTS, "extra.bin": b"not in the manifest"})
    report = verify_model(storage, spec)
    assert report.passed
    assert [r.file.path for r in report.files] == list(CONTENTS)


# --- CLI ----------------------------------------------------------------------------------------


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("PEBBLE_DATA_DIR", str(tmp_path / "pebble"))
    return tmp_path / "pebble"


def test_models_list_shows_the_manifest_without_touching_the_network(env, capsys):
    assert main(["models", "list"]) == 0
    out = capsys.readouterr().out
    for spec in MANIFEST:
        assert spec.model_id in out and spec.revision in out and spec.card_url in out
    assert "Apache-2.0" in out
    assert "0 of 6 files present" in out
    assert "Total: 1,296,079,251 bytes (1.30 GB)" in out


def test_models_verify_exits_non_zero_when_models_are_missing(env, capsys):
    assert main(["models", "verify"]) == 1
    out = capsys.readouterr().out
    assert out.count("MISSING") == sum(len(s.files) for s in MANIFEST)
    assert "0 passed, 0 failed, 14 missing. Models are NOT ready." in out
    assert MANIFEST[0].files[2].sha256 in out


def test_models_verify_output_reports_expected_and_actual_per_file(storage, capsys):
    spec = _fake_spec(CONTENTS)
    _install(storage, spec, {**CONTENTS, "model.pt": b"WEIGHTS"})
    assert commands.run(storage, "verify", [spec]) == 1
    out = capsys.readouterr().out
    bad = hashlib.sha256(b"WEIGHTS").hexdigest()
    assert f"expected sha256 {spec.files[2].sha256}  size 7" in out
    assert f"actual   sha256 {bad}  size 7" in out
    assert "2 passed, 1 failed, 0 missing. Models are NOT ready." in out


def test_models_verify_exits_zero_when_everything_passes(storage, capsys):
    spec = _fake_spec(CONTENTS)
    _install(storage, spec, CONTENTS)
    assert commands.run(storage, "verify", [spec]) == 0
    assert "3 passed, 0 failed, 0 missing. All models verified." in capsys.readouterr().out


# --- pull (fake downloader) -----------------------------------------------------------------------


def _fake_downloader(contents: dict[str, bytes], calls: list[dict]):
    def download(*, model_id, revision, local_dir, allow_patterns):
        calls.append(
            dict(
                model_id=model_id,
                revision=revision,
                local_dir=local_dir,
                allow_patterns=allow_patterns,
            )
        )
        for name in allow_patterns:
            if name in contents:
                path = os.path.join(local_dir, name)
                with open(path, "wb") as handle:
                    handle.write(contents[name])
        return local_dir

    return download


def test_pull_downloads_pinned_revision_and_only_manifest_files(storage):
    spec = _fake_spec(CONTENTS)
    calls: list[dict] = []
    [report] = pull(storage, [spec], _fake_downloader(CONTENTS, calls), report=lambda _: None)
    assert calls == [
        dict(
            model_id="test/fake-model",
            revision="v1.0.0",
            local_dir=str(storage.root / "models" / "test" / "fake-model"),
            allow_patterns=list(CONTENTS),
        )
    ]
    assert report.passed
    for result in report.files:
        assert result.path.stat().st_mode & 0o777 == 0o600
    assert model_dir(storage, spec).stat().st_mode & 0o777 == 0o700
    assert (storage.root / "models").stat().st_mode & 0o777 == 0o700


def test_pull_skips_models_that_already_verify(storage):
    spec = _fake_spec(CONTENTS)
    _install(storage, spec, CONTENTS)
    calls: list[dict] = []
    [report] = pull(storage, [spec], _fake_downloader(CONTENTS, calls), report=lambda _: None)
    assert calls == [] and report.passed


def test_pull_reports_a_corrupt_download_as_failed(storage):
    spec = _fake_spec(CONTENTS)
    corrupt = {**CONTENTS, "model.pt": b"truncat"}
    [report] = pull(storage, [spec], _fake_downloader(corrupt, []), report=lambda _: None)
    assert not report.passed
    assert _status(report)["model.pt"] == "fail"


def test_pull_refuses_to_download_through_a_symlink(storage, tmp_path):
    spec = _fake_spec(CONTENTS)
    (tmp_path / "elsewhere").mkdir()
    (storage.root / "models").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(PermissionError, match="symlink"):
        pull(storage, [spec], _fake_downloader(CONTENTS, []), report=lambda _: None)
    assert list((tmp_path / "elsewhere").iterdir()) == []


def test_hub_environment_keeps_modelscope_state_inside_the_data_directory(storage):
    env = hub_environment(storage)
    assert env == {
        "MODELSCOPE_CACHE": str(storage.root / "models"),
        "MODELSCOPE_HOME": str(storage.root / "models" / ".modelscope"),
    }


def test_pull_explains_how_to_install_modelscope_when_missing(env, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "modelscope", None)
    monkeypatch.setitem(sys.modules, "modelscope.hub", None)
    monkeypatch.setitem(sys.modules, "modelscope.hub.snapshot_download", None)
    for name in ("MODELSCOPE_CACHE", "MODELSCOPE_HOME"):
        monkeypatch.delenv(name, raising=False)
    assert main(["models", "pull"]) == 2
    assert "uv sync --extra funasr" in capsys.readouterr().out
    assert not (env / "models").exists()


def test_modelscope_downloader_sets_hub_environment_before_import(storage, monkeypatch):
    for name in ("MODELSCOPE_CACHE", "MODELSCOPE_HOME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setitem(sys.modules, "modelscope", None)
    with pytest.raises(Exception, match="ModelScope is not installed"):
        modelscope_downloader(storage)
    assert os.environ["MODELSCOPE_CACHE"] == str(storage.root / "models")
    assert os.environ["MODELSCOPE_HOME"] == str(storage.root / "models" / ".modelscope")
