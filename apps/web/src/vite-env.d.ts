/// <reference types="vite/client" />

/** True only in the local-mode build (`VITE_PEBBLE_MODE=local`). */
declare const __PEBBLE_LOCAL__: boolean;
/** The local worker's base URL in local mode; empty in the demo build. */
declare const __PEBBLE_WORKER_URL__: string;
