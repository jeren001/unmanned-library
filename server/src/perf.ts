// Measures borrow/return latency and event-to-SSE latency while the overload scenario runs,
// then writes the results table to docs/PERFORMANCE.md. Run with `npm run perf` in /server.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = Number(process.env.PERF_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const DURATION_MS = Number(process.env.PERF_DURATION_MS ?? 20_000);
const WORKERS = Number(process.env.PERF_WORKERS ?? 8);
const OVERLOAD_EVERY_MS = Number(process.env.PERF_OVERLOAD_EVERY_MS ?? 1_000);
const PROBE_EVERY_MS = 250;
const REPORT = resolve(process.cwd(), "../docs/PERFORMANCE.md");

type Json = Record<string, unknown>;
type Pending = { sentAt: number };

const tempDir = mkdtempSync(join(tmpdir(), "ul-perf-"));
const env = { ...process.env, DB_FILE: join(tempDir, "perf.sqlite"), SERVER_PORT: String(PORT), LOG_LEVEL: "warn" };
let server: ChildProcess | undefined;

function percentile(values: number[], p: number) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Server did not start");
}

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as Json;
  return { status: response.status, payload };
}

async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "admin", account: "admin", password: "admin123" })
  });
  if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

// Reads the SSE stream and records receive time minus the event's own timestamp,
// or minus the client send time for probe samples we injected ourselves.
function openStream(cookie: string, results: { circulation: number[]; overload: number[]; probe: number[] }, probes: Map<string, Pending>) {
  const controller = new AbortController();
  const ready = (async () => {
    const response = await fetch(`${BASE}/api/stream?topics=circulation.borrowed,circulation.returned,telemetry.received`, { headers: { cookie }, signal: controller.signal });
    if (response.status !== 200 || !response.body) throw new Error(`SSE failed: ${response.status}`);
    return response.body;
  })();
  const done = ready.then(async (body) => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of body) {
        const receivedAt = Date.now();
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!name || !data) continue;
          const payload = JSON.parse(data) as Json;
          if (name.startsWith("circulation.")) {
            results.circulation.push(receivedAt - Date.parse(String(payload.ts)));
          } else if (String(payload.metric).startsWith("overload_")) {
            results.overload.push(receivedAt - Date.parse(String(payload.ts)));
          } else if (payload.metric === "perf_probe") {
            const key = String(payload.value);
            const probe = probes.get(key);
            if (probe) { results.probe.push(receivedAt - probe.sentAt); probes.delete(key); }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
    }
  });
  return { ready, done, close: () => controller.abort() };
}

async function main() {
  console.log(`Seeding ${env.DB_FILE}`);
  const seeded = spawnSync("npx", ["tsx", "src/seed.ts"], { env, stdio: "inherit" });
  if (seeded.status !== 0) throw new Error("Seed failed");
  server = spawn("npx", ["tsx", "src/index.ts"], { env, stdio: ["ignore", "ignore", "inherit"], detached: true });
  await waitForServer();
  const cookie = await login();

  const books = ((await api(cookie, "GET", "/api/books?status=on_shelf&limit=200")).payload.data as Json[]).map((book) => ({ id: String(book.id), branchId: String(book.branch_id) }));
  const readers = ((await api(cookie, "GET", "/api/readers?status=active&limit=200")).payload.data as Json[]).filter((reader) => reader.role === "reader").map((reader) => String(reader.id));
  const devices = (await api(cookie, "GET", "/api/devices?limit=200")).payload.data as Json[];
  const branches = ((await api(cookie, "GET", "/api/branches")).payload.data as Json[]).map((branch) => String(branch.id));
  const probeDevice = devices.find((device) => device.kind === "temp_humidity") ?? devices[0]!;

  const sse = { circulation: [] as number[], overload: [] as number[], probe: [] as number[] };
  const probes = new Map<string, Pending>();
  const stream = openStream(cookie, sse, probes);
  await stream.ready;

  let running = true;
  let overloadRuns = 0;
  const overload = (async () => {
    while (running) {
      const started = Date.now();
      const result = await api(cookie, "POST", "/api/simulator/scenario", { scenario: "overload", branchId: branches[overloadRuns % branches.length] });
      if (result.status !== 202) throw new Error(`Overload scenario failed: ${result.status}`);
      overloadRuns += 1;
      await new Promise((done) => setTimeout(done, Math.max(0, OVERLOAD_EVERY_MS - (Date.now() - started))));
    }
  })();
  let probeSeq = 0;
  const probing = (async () => {
    while (running) {
      probeSeq += 1;
      probes.set(String(probeSeq), { sentAt: Date.now() });
      await api(cookie, "POST", "/api/telemetry", { deviceId: probeDevice.id, branchId: probeDevice.branch_id, metric: "perf_probe", value: probeSeq });
      await new Promise((done) => setTimeout(done, PROBE_EVERY_MS));
    }
  })();

  const borrow: number[] = [];
  const giveBack: number[] = [];
  const failures: string[] = [];
  let skipped = 0;
  let nextCycle = 0;
  let deadline = Number.POSITIVE_INFINITY;
  const worker = async (workerIndex: number) => {
    let readerIndex = workerIndex;
    while (Date.now() < deadline) {
      const cycle = nextCycle;
      nextCycle += 1;
      const book = books[cycle % books.length]!;
      let loanId: string | undefined;
      let lastCode = "";
      for (let attempt = 0; attempt < readers.length && !loanId; attempt += 1) {
        const started = performance.now();
        const result = await api(cookie, "POST", "/api/loans/borrow", { bookId: book.id, userId: readers[readerIndex % readers.length], branchId: book.branchId, idempotencyKey: `perf-${cycle}-${attempt}` });
        const elapsed = performance.now() - started;
        lastCode = String(result.payload.code ?? result.status);
        if (result.status === 201) { borrow.push(elapsed); loanId = String((result.payload.data as Json).id); }
        else if (lastCode === "BOOK_UNAVAILABLE") break;
        else readerIndex += WORKERS;
      }
      // The running simulator also borrows books, so an occasional busy book is contention, not an error.
      if (!loanId && lastCode === "BOOK_UNAVAILABLE") { skipped += 1; continue; }
      if (!loanId) { failures.push(`borrow ${book.id}: ${lastCode}`); continue; }
      const started = performance.now();
      const result = await api(cookie, "POST", `/api/loans/${loanId}/return`);
      const elapsed = performance.now() - started;
      if (result.status === 200) giveBack.push(elapsed);
      else failures.push(`return ${loanId}: ${result.status}`);
    }
  };
  const loadStarted = Date.now();
  await new Promise((done) => setTimeout(done, 1_500)); // let the first overload bursts land
  deadline = Date.now() + DURATION_MS;
  await Promise.all(Array.from({ length: WORKERS }, (_, index) => worker(index)));
  const loadSeconds = (Date.now() - loadStarted) / 1000;
  running = false;
  await Promise.all([overload, probing]);
  await new Promise((done) => setTimeout(done, 2_000)); // drain queued SSE events
  stream.close();
  await stream.done;

  const rows = [
    { name: "Borrow (`POST /api/loans/borrow`)", values: borrow, target: 1000 },
    { name: "Return (`POST /api/loans/:id/return`)", values: giveBack, target: 1000 },
    { name: "Circulation event → SSE (`circulation.*`)", values: sse.circulation, target: 3000 },
    { name: "Overload telemetry → SSE (`telemetry.received`)", values: sse.overload, target: 3000 },
    { name: "API telemetry probe → SSE (incl. 500 ms batching)", values: sse.probe, target: 3000 }
  ];
  const format = (value: number) => Number.isFinite(value) ? value.toFixed(1) : "n/a";
  const table = [
    "| Measurement | Samples | p50 (ms) | p95 (ms) | max (ms) | Target p95 | Result |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...rows.map((row) => {
      const p95 = percentile(row.values, 95);
      const pass = row.values.length > 0 && p95 <= row.target;
      return `| ${row.name} | ${row.values.length} | ${format(percentile(row.values, 50))} | ${format(p95)} | ${format(Math.max(...row.values))} | ≤ ${row.target / 1000} s | ${pass ? "pass" : "FAIL"} |`;
    })
  ].join("\n");
  const allPass = rows.every((row) => row.values.length > 0 && percentile(row.values, 95) <= row.target) && failures.length === 0;

  const report = `# Performance

Generated by \`npm run perf\` in \`/server\` (\`server/src/perf.ts\`). Re-run it after changes
to circulation, the event bus, the telemetry pipeline, or SSE; it overwrites this file.

## Method

- Fresh seeded SQLite database in a temp folder; the server runs as a separate process
  (\`tsx src/index.ts\`, simulator enabled with defaults) on port ${PORT}.
- Load: \`POST /api/simulator/scenario\` with \`overload\` every ${OVERLOAD_EVERY_MS} ms, rotating
  branches (500 telemetry samples per run, ${overloadRuns} runs = ${overloadRuns * 500} samples), plus one
  \`POST /api/telemetry\` probe every ${PROBE_EVERY_MS} ms.
- During the load, ${WORKERS} concurrent clients run borrow → return cycles as admin for
  ${DURATION_MS / 1000} s (${nextCycle} cycles).
  Latency is measured client-side from request send to response received.
- One SSE client subscribes to \`circulation.borrowed\`, \`circulation.returned\`, and
  \`telemetry.received\`. Event latency is SSE receive time minus the event's \`ts\`
  (set by the server when the event happens); for probes it is receive time minus the
  client's send time. Client and server share one clock (same machine).

## Results

Run on ${new Date().toISOString()} · Node ${process.version} · ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads) · load phase ${loadSeconds.toFixed(1)} s.

${table}

${failures.length ? `Failed operations (${failures.length}): ${failures.slice(0, 10).join("; ")}` : "All borrow/return operations succeeded."}${skipped ? ` ${skipped} borrow attempt(s) skipped because the simulator had the book on loan (\`BOOK_UNAVAILABLE\`).` : ""}

Targets: borrow/return p95 ≤ 1 s; event-to-SSE p95 ≤ 3 s. Overall: **${allPass ? "pass" : "FAIL"}**.
`;
  writeFileSync(REPORT, report);
  console.log(table);
  console.log(`Wrote ${REPORT}`);
  if (!allPass) process.exitCode = 1;
}

main()
  .catch((error: unknown) => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already exited */ } }
    rmSync(tempDir, { recursive: true, force: true });
  });
