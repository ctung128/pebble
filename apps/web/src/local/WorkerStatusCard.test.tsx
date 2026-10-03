import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeHealth } from "../test/localFixtures.tsx";
import { WorkerStatusCard } from "./WorkerStatusCard.tsx";

describe("WorkerStatusCard", () => {
  it("says the worker is ready", () => {
    render(
      <WorkerStatusCard status={{ kind: "ready", health: makeHealth() }} onRecheck={vi.fn()} />,
    );
    expect(screen.getByText("Local worker is ready.")).toBeInTheDocument();
  });

  it("gives the exact command when the worker isn't running", async () => {
    const onRecheck = vi.fn();
    render(<WorkerStatusCard status={{ kind: "not-running" }} onRecheck={onRecheck} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Pebble's local worker is not running.");
    expect(screen.getByText("npm run worker")).toBeInTheDocument();
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
    expect(screen.getByText(/npm run worker:doctor/)).toBeInTheDocument();
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
