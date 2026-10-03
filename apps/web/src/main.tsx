import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createDefaultSource } from "./data/DemoFixtureSource.ts";
import { SourceProvider } from "./data/SourceContext.tsx";
import { devFlags } from "./devFlags.ts";
import { LearningProvider } from "./features/learning/LearningContext.tsx";
import { openLearningStore } from "./features/learning/openLearningStore.ts";
import { DemoTranslationProvider } from "./features/translation/DemoTranslationProvider.ts";
import { TranslationProviderContext } from "./features/translation/TranslationContext.tsx";
import { SessionCachedTranslationProvider } from "./features/translation/TranslationProvider.ts";
import "./styles/tokens.css";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const source = createDefaultSource();
const translations = new SessionCachedTranslationProvider(
  new DemoTranslationProvider({
    locate: (episodeId) => source.getDemoTranslationsUrl(episodeId),
    alwaysFail: devFlags.failTranslations,
  }),
);

createRoot(root).render(
  <StrictMode>
    <SourceProvider source={source}>
      <TranslationProviderContext provider={translations}>
        <LearningProvider openStore={openLearningStore}>
          <App />
        </LearningProvider>
      </TranslationProviderContext>
    </SourceProvider>
  </StrictMode>,
);
