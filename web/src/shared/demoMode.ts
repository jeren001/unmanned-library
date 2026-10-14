/**
 * Demo mode shows the demo accounts on /login (staff hint and the reader "Simulate scan" button).
 * It is on only when VITE_DEMO_MODE is "true": web/.env.development sets it for `npm run dev`,
 * web/.env.production turns it off for the production build (a shell variable overrides either).
 */
export function isDemoMode(env: { VITE_DEMO_MODE?: string } = import.meta.env) {
  return env.VITE_DEMO_MODE === "true";
}

/** Compile-time constant, so a production build drops the demo UI and the demo credentials entirely. */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
