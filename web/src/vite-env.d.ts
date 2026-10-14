/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" shows the demo accounts on /login; see src/shared/demoMode.ts. */
  readonly VITE_DEMO_MODE?: string;
}
