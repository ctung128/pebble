import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { funasrHealth, makeHealth } from "../test/localFixtures.tsx";
import { WorkerStatusCard } from "./WorkerStatusCard.tsx";

describe("WorkerStatusCard", () => {
  it("says the mock worker is ready, unchanged", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "ready", mode: "mock", health: makeHealth() }}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByText("Local worker is ready.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Processing preview (placeholder transcript text)",
    );
  });

  it("says local transcription is ready for FunASR, without internal names", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "ready", mode: "funasr", health: funasrHealth() }}
        onRecheck={vi.fn()}
      />,
    );
    const card = screen.getByRole("status");
    expect(card).toHaveTextContent("Local transcription is ready.");
    expect(card).toHaveTextContent("Mandarin speech recognition on this computer");
    expect(card).not.toHaveTextContent(/FunASR|Paraformer|placeholder|model\.pt|uv sync/);
  });

  it("shows that speech models are being checked", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "provider-checking", mode: "funasr" }}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking local speech models…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains FunASR setup with only the worker's hint, its command as code", () => {
    render(
      <WorkerStatusCard
        status={{
          kind: "provider-setup",
          mode: "funasr",
          hint: "Download the speech models (about 1.3 GB) with: npm run pebble:setup",
        }}
        onRecheck={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Pebble's local transcription needs setup.");
    expect(screen.getByText("npm run pebble:setup").tagName).toBe("CODE");
    expect(alert).not.toHaveTextContent(/doctor|FunASR|uv sync/);
  });

  it.each([
    ["funasr", "Pebble's local transcription isn't available."],
    ["mock", "Pebble's processing preview isn't available."],
  ] as const)("names the unavailable %s provider in its own words", (mode, title) => {
    render(
      <WorkerStatusCard
        status={{ kind: "provider-unavailable", mode, hint: "Restart the worker and try again." }}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(title);
    expect(screen.getByText("Restart the worker and try again.")).toBeInTheDocument();
  });

  it("explains a provider configuration mismatch", () => {
    render(<WorkerStatusCard status={{ kind: "provider-mismatch" }} onRecheck={vi.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Pebble's local worker configuration does not match this app.");
    expect(alert).toHaveTextContent("npm run pebble:start");
  });

  it("gives the exact command when the worker isn't running", async () => {
    const onRecheck = vi.fn();
    render(<WorkerStatusCard status={{ kind: "not-running" }} onRecheck={onRecheck} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Pebble's local worker is not running.");
    expect(screen.getByText("npm run pebble:start")).toBeInTheDocument();
    expect(screen.getByText("npm run pebble:setup")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRecheck).toHaveBeenCalled();
  });

  it("points to FFmpeg setup and the doctor", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "needs-ffmpeg", missing: ["ffmpeg"] }}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByText("Audio processing needs FFmpeg.")).toBeInTheDocument();
    expect(screen.getByText(/npm run pebble:doctor/)).toBeInTheDocument();
  });

  it("explains a version mismatch with a next step", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "version-mismatch", detail: "Too old." }}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByText("Pebble's app and worker versions do not match.")).toBeInTheDocument();
    expect(screen.getByText(/start it again from this same Pebble folder/)).toBeInTheDocument();
  });

  it("shows the data folder path and the worker's hint", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "data-dir", path: "~/.pebble", hint: "Fix permissions, then restart." }}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByText("Pebble cannot access its local data folder.")).toBeInTheDocument();
    expect(screen.getByText("~/.pebble")).toBeInTheDocument();
    expect(screen.getByText("Fix permissions, then restart.")).toBeInTheDocument();
  });
});
