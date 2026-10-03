import {
  createHashRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useParams,
  type RouteObject,
} from "react-router";
import { StatusView } from "./components/StatusView.tsx";
import { StorageNotice } from "./components/StorageNotice.tsx";
import { useLearning } from "./features/learning/LearningContext.tsx";
import { LearningItemsPage } from "./features/learning/LearningItemsPage.tsx";
import { EpisodePage } from "./features/episode/EpisodePage.tsx";
import { LibraryPage } from "./features/library/LibraryPage.tsx";
import logoMark from "./assets/logo-mark.png";
import styles from "./App.module.css";

function Layout() {
  const { items } = useLearning();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <img className={styles.logo} src={logoMark} alt="" width={32} height={32} />
          Pebble
        </Link>
        <span
          className={styles.mode}
          title="Bundled sample content only. Nothing is uploaded or transcribed."
        >
          Demo
        </span>
        <nav className={styles.nav} aria-label="Main">
          <NavLink to="/items" className={styles.navLink}>
            Learning items
            {items.length > 0 ? <span className={styles.count}>{items.length}</span> : null}
          </NavLink>
        </nav>
      </header>
      <StorageNotice />
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
