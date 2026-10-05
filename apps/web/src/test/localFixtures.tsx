import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import {
  CURRENT_SCHEMA_VERSION,
  parseWorkerHealth,
  type Job,
  type WorkerHealth,
} from "@pebble/schema";
import { vi } from "vitest";
import type { EpisodeSource } from "../data/EpisodeSource.ts";
import { SourceProvider } from "../data/SourceContext.tsx";
import { LearningProvider } from "../features/learning/LearningContext.tsx";
import { MemoryLearningStore } from "../features/learning/MemoryLearningStore.ts";
import { TranslationProviderContext } from "../features/translation/TranslationContext.tsx";
import { SessionCachedTranslationProvider } from "../features/translation/TranslationProvider.ts";
import type { WorkerClient } from "../local/workerClient.ts";
import { WorkerProvider } from "../local/WorkerContext.tsx";
import { fakeSource, fakeTranslationProvider } from "./fixtures.tsx";

export const EPISODE_ID = "ep-0123456789ab";
export const JOB_ID = "job-0123456789ab";

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: JOB_ID,
    episodeId: EPISODE_ID,
    episodeTitle: "Morning walk",
    status: "queued",
    stage: null,
    attempt: 1,
    progress: null,
    failure: null,
    provider: { id: "mock", kind: "mock" },
    createdAt: "2026-10-03T12:00:00.000Z",
    updatedAt: "2026-10-03T12:00:00.000Z",
    ...overrides,
  };
}

export function makeHealth(overrides: Partial<WorkerHealth> = {}): WorkerHealth {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workerVersion: "0.1.0",
    status: "ok",
    dataDirWritable: true,
    dataDir: { path: "~/.pebble", writable: true, hint: null },
    tools: {
      ffmpeg: { available: true, version: "9.0.2" },
      ffprobe: { available: true, version: "9.0.2" },
    },
    providers: [{ id: "mock", kind: "mock", available: true, detail: "Placeholder text." }],
    ...overrides,
  };
}

type ProviderStatus = WorkerHealth["providers"][number];

/** Health from a FunASR worker (`npm run pebble:start`; contract 1.5). */
export function funasrHealth(provider: Partial<ProviderStatus> = {}): WorkerHealth {
  const ready = (provider.state ?? "ready") === "ready";
  return makeHealth({
    status: ready ? "ok" : "degraded",
    providers: [
      {
        id: "funasr",
        kind: "asr",
        available: ready,
        detail: "Developer detail: FunASR Paraformer, model.pt, uv sync --extra funasr.",
        state: "ready",
        ...provider,
      },
    ],
  });
}

/** A WorkerClient whose every method is a spy; healthy and empty by default. */
export function fakeWorkerClient(overrides: Partial<WorkerClient> = {}) {
  const client = {
    baseUrl: "http://127.0.0.1:8790/",
    health: vi.fn(async () => parseWorkerHealth(makeHealth())),
    listJobs: vi.fn(async (): Promise<Job[]> => []),
    getJob: vi.fn(async () => makeJob()),
    cancelJob: vi.fn(async () => makeJob({ status: "cancelled" })),
    retryJob: vi.fn(async () => makeJob({ attempt: 2 })),
    deleteEpisode: vi.fn(async () => undefined),
    renameEpisode: vi.fn(async (_id: string, title: string) =>
      makeJob({ episodeTitle: title, status: "completed", stage: "merging" }),
    ),
    upload: vi.fn(async () => makeJob()),
    ...overrides,
  } satisfies WorkerClient;
  return client;
}

function JobRouteProbe() {
  const { jobId } = useParams();
  return <p>Job page {jobId}</p>;
}

function EpisodeRouteProbe() {
  const { episodeId } = useParams();
  return <p>Episode page {episodeId}</p>;
}

interface LocalRenderOptions {
  client?: WorkerClient;
  store?: MemoryLearningStore;
  source?: EpisodeSource;
  path?: string;
  route?: string;
  /** Overrides how browser storage opens (e.g. never, to test the loading state). */
  openStore?: () => Promise<MemoryLearningStore>;
}

/** Renders a local-mode page inside the worker, source, translation and learning providers. */
export function renderLocal(ui: ReactNode, options: LocalRenderOptions = {}) {
  const client = options.client ?? fakeWorkerClient();
  const store = options.store ?? new MemoryLearningStore();
  const translation = new SessionCachedTranslationProvider(fakeTranslationProvider().provider);
  const result = render(
    <WorkerProvider client={client}>
      <SourceProvider source={options.source ?? fakeSource()}>
        <TranslationProviderContext provider={translation}>
          <LearningProvider openStore={options.openStore ?? (() => Promise.resolve(store))}>
            <MemoryRouter initialEntries={[options.route ?? "/"]}>
              <Routes>
                <Route path={options.path ?? "/"} element={ui} />
                <Route path="/jobs/:jobId" element={<JobRouteProbe />} />
                <Route path="/episodes/:episodeId" element={<EpisodeRouteProbe />} />
              </Routes>
            </MemoryRouter>
          </LearningProvider>
        </TranslationProviderContext>
      </SourceProvider>
    </WorkerProvider>,
  );
  return { ...result, client, store };
}
