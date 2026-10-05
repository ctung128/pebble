import {
  createHashRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
  type RouteObject,
} from "react-router";
import { useState } from "react";
import { PlusIcon } from "./components/Icon.tsx";
import { ShortcutSlotProvider } from "./components/ShellSlot.tsx";
import { StatusView } from "./components/StatusView.tsx";
import { StorageNotice } from "./components/StorageNotice.tsx";
import { useLearning } from "./features/learning/LearningContext.tsx";
import { LearningItemsPage } from "./features/learning/LearningItemsPage.tsx";
import { EpisodePage } from "./features/episode/EpisodePage.tsx";
import { LibraryPage } from "./features/library/LibraryPage.tsx";
import logoMark from "./assets/logo-mark.png";
import styles from "./App.module.css";

export type AppMode = "demo" | "local";

const MODE_CHIP: Record<AppMode, { label: string; title: string }> = {
  demo: {
    label: "Demo",
    title: "Bundled sample content only. Nothing is uploaded or transcribed.",
  },
  local: {
    label: "Local",
    title: "Runs with Pebble's worker on this computer. Your audio stays here.",
  },
};

/** Episode and job pages belong to the Library: its tab stays highlighted there. */
const LIBRARY_SECTION = /^\/(?:$|episodes\/|jobs\/)/;

export function Layout({ mode }: { mode: AppMode }) {
  const { items } = useLearning();
  const { pathname } = useLocation();
  const [shortcutSlot, setShortcutSlot] = useState<HTMLElement | null>(null);
  const chip = MODE_CHIP[mode];
  return (
    <div className={styles.shell}>
      <header className={styles.sidebar}>
        <div className={styles.brandRow}>
          <Link to="/" className={styles.brand}>
            <img className={styles.logo} src={logoMark} alt="" width={36} height={36} />
            Pebble
          </Link>
          <span className={styles.mode} title={chip.title}>
            {chip.label}
          </span>
        </div>
        {mode === "local" ? (
          <NavLink to="/process" className={styles.primary}>
            <PlusIcon size={18} />
            <span className={styles.primaryLabel}>Add audio</span>
          </NavLink>
        ) : null}
        <nav className={styles.nav} aria-label="Main">
          <NavLink
            to="/"
            end
            className={styles.navLink}
            data-section={LIBRARY_SECTION.test(pathname) || undefined}
          >
            Library
            <span className={styles.navGlyph} lang="zh-CN" aria-hidden="true">
              书架
            </span>
          </NavLink>
          <NavLink to="/items" className={styles.navLink}>
            Learning items
            {items.length > 0 ? <span className={styles.count}>{items.length}</span> : null}
          </NavLink>
        </nav>
        {/* The episode page renders its keyboard shortcuts here (ShortcutSlot). */}
        <div ref={setShortcutSlot} className={styles.shortcuts} />
      </header>
      <div className={styles.column}>
        <StorageNotice />
        <main className={styles.main}>
          <ShortcutSlotProvider value={shortcutSlot}>
            <Outlet />
          </ShortcutSlotProvider>
        </main>
      </div>
    </div>
  );
}

export function EpisodeRoute() {
  const { episodeId = "" } = useParams();
  // Keyed so switching episodes resets player and loading state.
  return <EpisodePage key={episodeId} episodeId={episodeId} />;
}

export function NotFound() {
  return (
    <StatusView kind="empty" title="Page not found" message="That page doesn't exist in Pebble." />
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout mode="demo" />,
    children: [
      { index: true, element: <LibraryPage /> },
      { path: "episodes/:episodeId", element: <EpisodeRoute /> },
      { path: "items", element: <LearningItemsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

// Hash routing keeps the static demo host-agnostic (no server rewrites needed).
const router = createHashRouter(routes);

export function App() {
  return <RouterProvider router={router} />;
}
