import {
  createHashRouter,
  Link,
  Outlet,
  RouterProvider,
  useParams,
  type RouteObject,
} from "react-router";
import { StatusView } from "./components/StatusView.tsx";
import { EpisodePage } from "./features/episode/EpisodePage.tsx";
import { LibraryPage } from "./features/library/LibraryPage.tsx";
import styles from "./App.module.css";

function Layout() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <ellipse cx="16" cy="17" rx="13" ry="10" fill="currentColor" />
          </svg>
          Pebble
        </Link>
        <span
          className={styles.mode}
          title="Bundled sample content only. Nothing is uploaded or transcribed."
        >
          Demo
        </span>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}

function EpisodeRoute() {
  const { episodeId = "" } = useParams();
  // Keyed so switching episodes resets player and loading state.
  return <EpisodePage key={episodeId} episodeId={episodeId} />;
}

function NotFound() {
  return (
    <StatusView kind="empty" title="Page not found" message="That page doesn't exist in Pebble." />
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <LibraryPage /> },
      { path: "episodes/:episodeId", element: <EpisodeRoute /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

// Hash routing keeps the static demo host-agnostic (no server rewrites needed).
const router = createHashRouter(routes);

export function App() {
  return <RouterProvider router={router} />;
}
