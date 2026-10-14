# Unmanned Library

Minimal monorepo scaffold for the Unmanned Library prototype.

## Requirements

- Node.js 20+
- npm

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

- Web: http://localhost:3000
- API health check through Vite proxy: http://localhost:3000/api/health
- Server direct health check: http://localhost:3001/api/health

### Demo mode

`VITE_DEMO_MODE=true` shows the demo accounts on `/login`: the "Demo account" prefill under the
librarian and admin forms, and the reader tab's "Simulate scan" button. It is on for `npm run dev`
(`web/.env.development`) and off in the production build (`web/.env.production`). A shell variable
overrides both, e.g. `VITE_DEMO_MODE=false npm run dev`. Never enable it on a public deployment.

## Scripts

```bash
npm run build
npm test
npm run lint
```

## Documentation

- [docs/DEMO_ACCOUNTS.md](docs/DEMO_ACCOUNTS.md) — demo logins for each role (reader / librarian / admin)
