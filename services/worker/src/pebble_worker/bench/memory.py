"""
Memory measurement, one method for every run (macOS):

- `physFootprint*` — the kernel's physical footprint (what Activity Monitor calls "Memory"),
  read with `proc_pid_rusage(RUSAGE_INFO_V4)`. The job peak is sampled every 100 ms while the
  job runs; the lifetime peak is the kernel's own maximum for the process.
- `rssMaxBytes` — `getrusage(RUSAGE_SELF).ru_maxrss`, the process's peak resident set.

These are approximate, local measurements on one computer, not general claims. On other
platforms the footprint fields are null.
"""

from __future__ import annotations

import ctypes
import os
import resource
import sys
import threading
from dataclasses import dataclass

METHOD = "macos-proc_pid_rusage-v4+getrusage"
SAMPLE_SECONDS = 0.1

_V4_FIELDS = (
    "user_time",
    "system_time",
    "pkg_idle_wkups",
    "interrupt_wkups",
    "pageins",
    "wired_size",
    "resident_size",
    "phys_footprint",
    "proc_start_abstime",
    "proc_exit_abstime",
    "child_user_time",
    "child_system_time",
    "child_pkg_idle_wkups",
    "child_interrupt_wkups",
    "child_pageins",
    "child_elapsed_abstime",
    "diskio_bytesread",
    "diskio_byteswritten",
    "cpu_time_qos_default",
    "cpu_time_qos_maintenance",
    "cpu_time_qos_background",
    "cpu_time_qos_utility",
    "cpu_time_qos_legacy",
    "cpu_time_qos_user_initiated",
    "cpu_time_qos_user_interactive",
    "billed_system_time",
    "serviced_system_time",
    "logical_writes",
    "lifetime_max_phys_footprint",
    "instructions",
    "cycles",
    "billed_energy",
    "serviced_energy",
    "interval_max_phys_footprint",
    "runnable_time",
)


class _RusageInfoV4(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in _V4_FIELDS]


_libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib") if sys.platform == "darwin" else None


def _rusage() -> _RusageInfoV4 | None:
    if _libc is None:
        return None
    info = _RusageInfoV4()
    if _libc.proc_pid_rusage(os.getpid(), 4, ctypes.byref(info)) != 0:
        return None
    return info


def phys_footprint() -> int | None:
    info = _rusage()
    return None if info is None else int(info.phys_footprint)


def rss_max_bytes() -> int:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if sys.platform == "darwin" else peak * 1024  # Linux reports KiB


@dataclass(frozen=True)
class MemoryResult:
    phys_footprint_job_peak_bytes: int | None
    phys_footprint_lifetime_peak_bytes: int | None
    rss_max_bytes: int

    def as_dict(self) -> dict[str, object]:
        return {
            "method": METHOD,
            "physFootprintJobPeakBytes": self.phys_footprint_job_peak_bytes,
            "physFootprintLifetimePeakBytes": self.phys_footprint_lifetime_peak_bytes,
            "rssMaxBytes": self.rss_max_bytes,
        }


class MemorySampler:
    """Samples the physical footprint in the background between `start` and `stop`."""

    def __init__(self) -> None:
        self._peak: int | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pebble-bench-memory", daemon=True)

    def start(self) -> MemorySampler:
        self._sample()
        self._thread.start()
        return self

    def stop(self) -> MemoryResult:
        self._stop.set()
        self._thread.join()
        self._sample()
        info = _rusage()
        return MemoryResult(
            phys_footprint_job_peak_bytes=self._peak,
            phys_footprint_lifetime_peak_bytes=(
                None if info is None else int(info.lifetime_max_phys_footprint)
            ),
            rss_max_bytes=rss_max_bytes(),
        )

    def _run(self) -> None:
        while not self._stop.wait(SAMPLE_SECONDS):
            self._sample()

    def _sample(self) -> None:
        value = phys_footprint()
        if value is not None and (self._peak is None or value > self._peak):
            self._peak = value
