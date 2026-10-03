import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SourceProvider } from "../data/SourceContext.tsx";
import { LearningProvider } from "../features/learning/LearningContext.tsx";
import { openLearningStore } from "../features/learning/openLearningStore.ts";
import { TranslationProviderContext } from "../features/translation/TranslationContext.tsx";
import {
  SessionCachedTranslationProvider,
  TranslationError,
  type TranslationProvider,
} from "../features/translation/TranslationProvider.ts";
import { LocalApp } from "./LocalApp.tsx";
import { LocalWorkerSource } from "./LocalWorkerSource.ts";
import { HttpWorkerClient } from "./workerClient.ts";
import { WorkerProvider } from "./WorkerContext.tsx";

/**
 * No translation provider exists in local mode yet. The reader needs one in context; its
 * English controls are disabled for mock transcripts, so this is never actually called.
 */
const noTranslation: TranslationProvider = {
  id: "none",
  translate: () =>
    Promise.reject(
      new TranslationError(
        "UNAVAILABLE",
        "Translation will be available after a real transcription and translation provider are connected.",
      ),
    ),
};

export function renderLocal(container: HTMLElement) {
  const client = new HttpWorkerClient(__PEBBLE_WORKER_URL__);
  const source = new LocalWorkerSource(__PEBBLE_WORKER_URL__);
  createRoot(container).render(
    <StrictMode>
      <WorkerProvider client={client}>
        <SourceProvider source={source}>
          <TranslationProviderContext
            provider={new SessionCachedTranslationProvider(noTranslation)}
          >
            <LearningProvider openStore={openLearningStore}>
              <LocalApp />
            </LearningProvider>
          </TranslationProviderContext>
        </SourceProvider>
      </WorkerProvider>
    </StrictMode>,
  );
}
