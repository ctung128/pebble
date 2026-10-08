import { createHashRouter, RouterProvider, type RouteObject } from "react-router";
import { EpisodeRoute, Layout, NotFound } from "../App.tsx";
import { LearningItemsPage } from "../features/learning/LearningItemsPage.tsx";
import { AddAudioPage } from "./AddAudioPage.tsx";
import { JobProgressRoute } from "./JobProgressPage.tsx";
import { LocalLibraryPage } from "./LocalLibraryPage.tsx";
import { LocalRenameProvider } from "./LocalRenameProvider.tsx";
import { LocalSpeakersProvider } from "./speakers/LocalSpeakersProvider.tsx";
import { LocalTranslationProvider } from "./LocalTranslationProvider.tsx";
import { TranslationSettingsPage } from "./TranslationSettingsPage.tsx";
import { TranslationUsageMeter } from "./TranslationUsageMeter.tsx";

export const localRoutes: RouteObject[] = [
  {
    path: "/",
    element: <Layout mode="local" footer={<TranslationUsageMeter />} />,
    children: [
      { index: true, element: <LocalLibraryPage /> },
      { path: "process", element: <AddAudioPage /> },
      { path: "jobs/:jobId", element: <JobProgressRoute /> },
      { path: "episodes/:episodeId", element: <EpisodeRoute /> },
      { path: "items", element: <LearningItemsPage /> },
      { path: "translation", element: <TranslationSettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

const router = createHashRouter(localRoutes);

export function LocalApp() {
  return (
    <LocalRenameProvider>
      <LocalTranslationProvider>
        <LocalSpeakersProvider>
          <RouterProvider router={router} />
        </LocalSpeakersProvider>
      </LocalTranslationProvider>
    </LocalRenameProvider>
  );
}
