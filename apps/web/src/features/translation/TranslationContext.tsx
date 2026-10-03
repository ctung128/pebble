import { createContext, useContext, type ReactNode } from "react";
import type { SessionCachedTranslationProvider } from "./TranslationProvider.ts";

const TranslationContext = createContext<SessionCachedTranslationProvider | null>(null);

export function TranslationProviderContext({
  provider,
  children,
}: {
  provider: SessionCachedTranslationProvider;
  children: ReactNode;
}) {
  return <TranslationContext.Provider value={provider}>{children}</TranslationContext.Provider>;
}

export function useTranslationProvider(): SessionCachedTranslationProvider {
  const provider = useContext(TranslationContext);
  if (!provider) throw new Error("useTranslationProvider must be used inside its provider.");
  return provider;
}
