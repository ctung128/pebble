import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { CURRENT_SCHEMA_VERSION, type Episode, type Transcript } from "@pebble/schema";
import { vi } from "vitest";
import { SourceError, type EpisodeSource, type ResolvedEpisode } from "../data/EpisodeSource.ts";
import { SourceProvider } from "../data/SourceContext.tsx";
import { LearningProvider } from "../features/learning/LearningContext.tsx";
import type { LearningStore } from "../features/learning/LearningStore.ts";
import { MemoryLearningStore } from "../features/learning/MemoryLearningStore.ts";
import { TranslationProviderContext } from "../features/translation/TranslationContext.tsx";
import {
  SessionCachedTranslationProvider,
  TranslationError,
  type TranslationProvider,
} from "../features/translation/TranslationProvider.ts";

export const testEpisode: Episode = {
  id: "test-001",
  title: "Test episode",
  titleZh: "测试节目",
  description: "Used by component tests.",
  language: "zh-CN",
  durationMs: 9000,
  audio: { src: "test-001/audio.m4a", mimeType: "audio/mp4" },
  transcript: { src: "test-001/transcript.json" },
  audioProvenance: { kind: "tts-placeholder", publishable: false, notes: "Test." },
  demo: { translations: "test-001/translations.en.json" },
};

export const testTranscript: Transcript = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  episodeId: "test-001",
  language: "zh-CN",
  script: "simplified",
  durationMs: 9000,
  segments: ["第一句。", "第二句。", "第三句。"].map((text, i) => ({
    id: `seg-${i + 1}`,
    index: i,
    startMs: i * 3000,
    endMs: i * 3000 + 2500,
    text,
    speaker: i % 2 === 0 ? "A" : "B",
    confidence: null,
    tokens: null,
  })),
  provenance: {
    kind: "fixture",
    provider: "fixture",
    model: null,
    createdAt: "2026-10-03T00:00:00Z",
  },
};

export const testTranslations: Record<string, string> = {
  "seg-1": "The first sentence.",
  "seg-2": "The second sentence.",
  "seg-3": "The third sentence.",
};

/** In-memory source for component tests. */
export function fakeSource(overrides: Partial<EpisodeSource> = {}): EpisodeSource {
  return {
    mode: "demo",
    listEpisodes: async () => [testEpisode],
    getEpisode: async (id): Promise<ResolvedEpisode> => {
      if (id !== testEpisode.id) throw new SourceError("NOT_FOUND", `No episode with id "${id}".`);
      return { ...testEpisode, audioUrl: "http://localhost/test-001/audio.m4a" };
    },
    getTranscript: async () => testTranscript,
    getReviewHints: async () => [],
    ...overrides,
  };
}

/** Instant translation provider backed by `testTranslations`, with a call spy. */
export function fakeTranslationProvider(options: { fail?: boolean } = {}) {
  const translate = vi.fn<TranslationProvider["translate"]>(async (request) => {
    if (options.fail) {
      throw new TranslationError(
        "UNAVAILABLE",
        "Translation is unavailable right now. Try again, or keep listening.",
      );
    }
    if (request.text !== request.sourceText) {
      throw new TranslationError("NOT_FOR_EDITED_TEXT", "No translation for edited text.");
    }
    return { text: testTranslations[request.segmentId] ?? "?", language: "en" };
  });
  return { provider: { id: "fake", translate } satisfies TranslationProvider, translate };
}

interface RenderOptions {
  source?: EpisodeSource;
  store?: LearningStore;
  openStore?: () => Promise<LearningStore>;
  translation?: TranslationProvider;
  route?: string;
}

/** Renders UI inside every app-level provider, with in-memory test doubles by default. */
export function renderWithProviders(ui: ReactNode, options: RenderOptions = {}) {
  const store = options.store ?? new MemoryLearningStore();
  const openStore = options.openStore ?? (() => Promise.resolve(store));
  const translation = new SessionCachedTranslationProvider(
    options.translation ?? fakeTranslationProvider().provider,
  );
  const result = render(
    <SourceProvider source={options.source ?? fakeSource()}>
      <TranslationProviderContext provider={translation}>
        <LearningProvider openStore={openStore}>
          <MemoryRouter initialEntries={[options.route ?? "/"]}>{ui}</MemoryRouter>
        </LearningProvider>
      </TranslationProviderContext>
    </SourceProvider>,
  );
  return { ...result, store };
}
