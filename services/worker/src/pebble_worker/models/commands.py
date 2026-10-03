"""Output for `pebble-worker models list|verify|pull`."""

from __future__ import annotations

from collections.abc import Sequence

from ..storage import Storage
from .manifest import MANIFEST, ModelSpec
from .pull import ModelscopeUnavailable, hub_environment, modelscope_downloader, pull
from .verify import ModelReport, file_path, model_dir, models_root, verify_model


def run(storage: Storage, action: str, specs: Sequence[ModelSpec] = MANIFEST) -> int:
    if action == "list":
        return list_models(storage, specs)
    if action == "verify":
        return print_reports([verify_model(storage, spec) for spec in specs])
    if action == "pull":
        return pull_models(storage, specs)
    raise ValueError(action)


def list_models(storage: Storage, specs: Sequence[ModelSpec]) -> int:
    print(f"Pinned models (directory: {models_root(storage)})")
    for spec in specs:
        present = sum(1 for file in spec.files if file_path(storage, spec, file).is_file())
        print()
        print(f"  {spec.role:<12} {spec.model_id}")
        print(f"  {'revision':<12} {spec.revision}")
        print(f"  {'card':<12} {spec.card_url}")
        print(f"  {'license':<12} {spec.license}")
        print(f"  {'attribution':<12} {spec.attribution}")
        print(f"  {'size':<12} {spec.total_size:,} bytes in {len(spec.files)} files")
        print(f"  {'location':<12} {model_dir(storage, spec)}")
        print(
            f"  {'on disk':<12} {present} of {len(spec.files)} files present "
            "(run `models verify` to check sizes and hashes)"
        )
    total = sum(spec.total_size for spec in specs)
    print(f"\nTotal: {total:,} bytes ({total / 1e9:.2f} GB)")
    return 0


def pull_models(storage: Storage, specs: Sequence[ModelSpec]) -> int:
    try:
        downloader = modelscope_downloader(storage)
    except ModelscopeUnavailable as error:
        print(f"pebble-worker: {error}")
        return 2
    total = sum(spec.total_size for spec in specs)
    print(f"Pulling {len(specs)} pinned models ({total / 1e9:.2f} GB) from ModelScope into")
    print(f"  {models_root(storage)}")
    for name, value in hub_environment(storage).items():
        print(f"  {name}={value}")
    return print_reports(pull(storage, specs, downloader))


def print_reports(reports: Sequence[ModelReport]) -> int:
    for report in reports:
        spec = report.spec
        print(f"\n{spec.model_id} @ {spec.revision} ({spec.role})")
        for result in report.files:
            print(f"  {result.status.upper():<8} {result.file.path}")
            print(f"           expected sha256 {result.file.sha256}  size {result.file.size:,}")
            if result.actual_sha256 is None:
                print("           actual   —")
            else:
                print(
                    f"           actual   sha256 {result.actual_sha256}  "
                    f"size {result.actual_size:,}"
                )
            if result.detail:
                print(f"           {result.detail}")
    counts = {status: 0 for status in ("pass", "fail", "missing")}
    for report in reports:
        for result in report.files:
            counts[result.status] += 1
    healthy = all(report.passed for report in reports)
    print(
        f"\n{counts['pass']} passed, {counts['fail']} failed, {counts['missing']} missing. "
        + ("All models verified." if healthy else "Models are NOT ready.")
    )
    return 0 if healthy else 1
