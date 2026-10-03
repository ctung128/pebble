import { createContext, useContext, type ReactNode } from "react";
import type { EpisodeSource } from "./EpisodeSource.ts";

const SourceContext = createContext<EpisodeSource | null>(null);

export function SourceProvider({
  source,
  children,
}: {
  source: EpisodeSource;
  children: ReactNode;
}) {
  return <SourceContext.Provider value={source}>{children}</SourceContext.Provider>;
}

export function useEpisodeSource(): EpisodeSource {
  const source = useContext(SourceContext);
  if (!source) throw new Error("useEpisodeSource must be used inside <SourceProvider>.");
  return source;
}
