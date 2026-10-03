import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeWorkerClient, makeJob, renderLocal } from "../test/localFixtures.tsx";
import { AddAudioPage, OWNERSHIP_LABEL } from "./AddAudioPage.tsx";
import { WorkerError } from "./workerClient.ts";

const audio = (name = "morning_walk.m4a", size = 3) =>
  new File([new Uint8Array(size)], name, { type: "audio/mp4" });

async function renderReady(client = fakeWorkerClient()) {
  const view = renderLocal(<AddAudioPage />, { client, path: "/process", route: "/process" });
  await screen.findByText("Local worker is ready.");
  return view;
}

const fileInput = () => screen.getByLabelText("Audio file");
const titleInput = () => screen.getByLabelText("Title");
const ownership = () => screen.getByLabelText(OWNERSHIP_LABEL);
const submitButton = () => screen.getByRole("button", { name: "Run processing preview" });

describe("AddAudioPage", () => {
  it("describes a processing preview, never real transcription", async () => {
    await renderReady();
    expect(screen.getByRole("heading", { name: "Process audio locally" })).toBeInTheDocument();
    expect(
      screen.getByText(
        /This preview uses placeholder transcript text while Mandarin speech recognition is being connected./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/stays private on this computer/)).toHaveTextContent("~/.pebble");
    expect(document.body.textContent).not.toMatch(/transcribe audio|create transcript/i);
  });

  it("offers no upload until the worker is ready", async () => {
    const client = fakeWorkerClient({
      health: async () => {
        throw new WorkerError("UNREACHABLE", "down");
      },
    });
    renderLocal(<AddAudioPage />, { client, path: "/process", route: "/process" });
    expect(await screen.findByText("Pebble's local worker is not running.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Audio file")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run processing preview" }),
    ).not.toBeInTheDocument();
  });

  it("prefills an editable title from the filename and keeps edits", async () => {
    await renderReady();
    await userEvent.upload(fileInput(), audio("morning_walk.m4a"));
    expect(titleInput()).toHaveValue("morning walk");
    await userEvent.clear(titleInput());
    await userEvent.type(titleInput(), "My title");
    await userEvent.upload(fileInput(), audio("other.mp3"));
    expect(titleInput()).toHaveValue("My title");
  });

  it("requires ownership confirmation", async () => {
    const { client } = await renderReady();
    await userEvent.upload(fileInput(), audio());
    await userEvent.click(submitButton());
    expect(
      screen.getByText("Confirm that you own this audio or are authorized to process it."),
    ).toBeInTheDocument();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("validates file type and title before uploading", async () => {
    const { client } = await renderReady();
    await userEvent.upload(fileInput(), new File(["x"], "notes.txt", { type: "text/plain" }), {
      applyAccept: false,
    });
    await userEvent.clear(titleInput());
    await userEvent.click(ownership());
    await userEvent.click(submitButton());
    expect(screen.getByText(/This file type isn't supported/)).toBeInTheDocument();
    expect(screen.getByText("Give the episode a title.")).toBeInTheDocument();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("shows upload progress, blocks duplicate submits, then opens the job", async () => {
    let finish!: () => void;
    const client = fakeWorkerClient({
      upload: vi.fn(async ({ onProgress }) => {
        onProgress?.({ loaded: 1024 * 1024, total: 4 * 1024 * 1024 });
        await new Promise<void>((resolve) => (finish = resolve));
        return makeJob({ id: "job-aaaaaaaaaaaa" });
      }),
    });
    await renderReady(client);
    await userEvent.upload(fileInput(), audio());
    await userEvent.click(ownership());

    const form = submitButton().closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form); // a second submit in the same tick
    expect(
      await screen.findByText(/Sending to the local worker… 1.0 MB of 4.0 MB/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(client.upload).toHaveBeenCalledWith(
      expect.objectContaining({ title: "morning walk", ownershipConfirmed: true }),
    );

    finish();
    expect(await screen.findByText("Job page job-aaaaaaaaaaaa")).toBeInTheDocument();
  });

  it("explains worker refusals and allows another attempt", async () => {
    const client = fakeWorkerClient({
      upload: vi.fn(async () => {
        throw new WorkerError("FILE_TOO_LARGE", "Too big.", { status: 413 });
      }),
    });
    await renderReady(client);
    await userEvent.upload(fileInput(), audio());
    await userEvent.click(ownership());
    await userEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file is larger than the worker's upload limit.",
    );
    await waitFor(() => expect(submitButton()).toBeEnabled());
  });
});
