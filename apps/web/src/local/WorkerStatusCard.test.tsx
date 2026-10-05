import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { funasrHealth, makeHealth } from "../test/localFixtures.tsx";
import { WorkerStatusCard } from "./WorkerStatusCard.tsx";
import type { WorkerStatus } from "./workerHealth.ts";

/** Nothing a learner sees by default may name tools, versions, paths or internals. */
const TECHNICAL =
  /ffmpeg|funasr|paraformer|worker|model\.pt|uv sync|~\/|\/Users\/|\d+\.\d+\.\d+|PEBBLE_|npm run/i;

/** The card's text with the closed "Show setup steps" disclosure left out. */
function visibleText(card: HTMLElement): string {
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details > :not(summary)").forEach((node) => node.remove());
  return clone.textContent ?? "";
}

describe("WorkerStatusCard", () => {
  it("says the processing preview is ready in plain words, without versions", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "ready", mode: "mock", health: makeHealth() }}
        onRecheck={vi.fn()}
      />,
    );
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Processing preview is ready.");
    expect(line).toHaveTextContent("placeholder text for testing");
    expect(line.textContent).not.toMatch(TECHNICAL);
  });

  it("says local transcription is ready, without internal names", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "ready", mode: "funasr", health: funasrHealth() }}
        onRecheck={vi.fn()}
      />,
    );
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Local transcription is ready.");
    expect(line.textContent).not.toMatch(TECHNICAL);
  });

  it("can stay silent once ready (the Library)", () => {
    const { container } = render(
      <WorkerStatusCard
        status={{ kind: "ready", mode: "funasr", health: funasrHealth() }}
        onRecheck={vi.fn()}
        showReady={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows that it is checking, without an alert", () => {
    render(
      <WorkerStatusCard
        status={{ kind: "provider-checking", mode: "funasr" }}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking local speech models…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    [{ kind: "not-running" }, "Pebble isn't running on this computer."],
    [{ kind: "needs-ffmpeg", missing: ["ffmpeg"] }, "Pebble needs one more setup step"],
    [
      { kind: "version-mismatch", detail: "worker 0.0.9 is older than 0.1.0" },
      "Pebble needs a restart.",
    ],
    [
      {
        kind: "data-dir",
        path: "/srv/pebble-test-data",
        hint: "Fix permissions on pebble-test-data.",
      },
      "Pebble can't save files on this computer.",
    ],
    [
      {
        kind: "provider-setup",
        mode: "funasr",
        hint: "Download the speech models (about 1.3 GB) with: npm run pebble:setup",
      },
      "Pebble's local transcription needs setup.",
    ],
    [
      { kind: "provider-unavailable", mode: "funasr", hint: "FunASR failed: model.pt missing" },
      "Pebble's local transcription isn't available.",
    ],
    [
      { kind: "provider-unavailable", mode: "mock", hint: "Restart the worker." },
      "Pebble's processing preview isn't available.",
    ],
    [{ kind: "provider-mismatch" }, "Pebble's setup doesn't match this page."],
    [{ kind: "origin-blocked" }, "Pebble can't connect from this page."],
  ] as const)("explains %o in plain language, with steps only on request", (status, title) => {
    render(<WorkerStatusCard status={status as WorkerStatus} onRecheck={vi.fn()} />);
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent(title);
    expect(visibleText(card)).not.toMatch(TECHNICAL);
    // Worker-supplied hints, details and paths never render, even inside the steps.
    expect(card).not.toHaveTextContent(
      /1\.3 GB|model\.pt|0\.0\.9|pebble-test-data|Fix permissions/,
    );
    const steps = card.querySelector("details")!;
    expect(steps).not.toHaveAttribute("open");
    expect(within(steps).getByText("Show setup steps").tagName).toBe("SUMMARY");
  });

  it("puts the exact commands behind Show setup steps, and rechecks on request", async () => {
    const onRecheck = vi.fn();
    render(<WorkerStatusCard status={{ kind: "not-running" }} onRecheck={onRecheck} />);
    await userEvent.click(screen.getByText("Show setup steps"));
    expect(screen.getByText("npm run pebble:start").tagName).toBe("CODE");
    expect(screen.getByText("npm run pebble:setup")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRecheck).toHaveBeenCalled();
  });
});
