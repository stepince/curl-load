import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFile, readFile, readdir, rm, mkdir } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Runs stored in memory — keyed by run ID
const runs = new Map();

// Base directory where run artifacts (scripts, logs) are written
const RUNS_BASE_DIR = path.resolve(__dirname, '../../../runs');

/**
 * Persist run metadata to {run.dir}/run.json (fire-and-forget).
 * Strips internal-only fields before writing.
 */
function saveRunToDisk(run) {
  const { process: _proc, dir: _dir, ...data } = run;
  mkdir(run.dir, { recursive: true })
    .then(() => writeFile(path.join(run.dir, 'run.json'), JSON.stringify(data, null, 2), 'utf8'))
    .catch((err) => console.error(`[run-store] saveRunToDisk failed for ${run.id}:`, err.message));
}

/**
 * Scan RUNS_BASE_DIR for saved runs and reload them into memory.
 * Any run that was in-progress (created/running/stopping) is marked failed.
 */
async function loadRunsFromDisk() {
  let entries;
  try {
    entries = await readdir(RUNS_BASE_DIR, { withFileTypes: true });
  } catch {
    // Directory doesn't exist yet — nothing to load
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runJsonPath = path.join(RUNS_BASE_DIR, entry.name, 'run.json');
    try {
      const raw = await readFile(runJsonPath, 'utf8');
      const data = JSON.parse(raw);
      const run = {
        ...data,
        dir: path.join(RUNS_BASE_DIR, data.id),
        process: null,
      };
      if (['created', 'running', 'stopping'].includes(run.status)) {
        run.status = 'failed';
        if (!run.finishedAt) run.finishedAt = new Date().toISOString();
      }
      runs.set(run.id, run);
    } catch {
      // Corrupt or missing run.json — skip
    }
  }
}

await loadRunsFromDisk();

/**
 * Create a new run record and return it.
 * @param {object} config - { url, method, headers, body, users, duration }
 */
export function createRun(config) {
  const id = randomUUID();
  const dir = path.join(RUNS_BASE_DIR, id);

  const run = {
    id,
    dir,
    config: {
      name: config.name || '',
      url: config.url,
      method: (config.method || 'GET').toUpperCase(),
      headers: config.headers || {},
      body: config.body || null,
      variables: config.variables || {},
      users: config.users || 10,
      duration: config.duration || '30s',
      pause: config.pause ?? 1,
    },
    dashboard: config.dashboard !== false,
    status: 'created',    // created → running → finished | failed | stopping → stopped
    process: null,        // child_process reference (not serialised)
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };

  runs.set(id, run);
  saveRunToDisk(run);
  return run;
}

/**
 * Update the status of a run (and set timestamps where appropriate).
 */
export function updateStatus(id, status, extra = {}) {
  const run = runs.get(id);
  if (!run) throw new Error(`run ${id} not found`);

  run.status = status;

  if (status === 'running' && !run.startedAt) {
    run.startedAt = new Date().toISOString();
  }
  if (['finished', 'failed', 'stopped'].includes(status) && !run.finishedAt) {
    run.finishedAt = new Date().toISOString();
  }

  Object.assign(run, extra);
  saveRunToDisk(run);
  return run;
}

/**
 * Retrieve a run by ID.  Returns undefined if not found.
 */
export function getRun(id) {
  return runs.get(id);
}

/**
 * List all runs (newest first).
 */
export function listRuns() {
  return [...runs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Delete a run from memory and remove its directory from disk.
 */
export async function deleteRun(id) {
  const run = runs.get(id);
  runs.delete(id);
  if (run?.dir) {
    await rm(run.dir, { recursive: true, force: true });
  }
}

/**
 * Return a safe, serialisable view of a run — strips internal fields
 * (process reference, filesystem path) that must not leave the server.
 */
export function serializeRun(run) {
  return {
    id:           run.id,
    status:       run.status,
    config:       run.config,
    dashboard:         run.dashboard,
    dashboardLive:     run.dashboard ? `http://${process.env.HOST || 'localhost'}:5665` : null,
    dashboardReport:   run.dashboard ? `/runs/${run.id}/dashboard` : null,
    createdAt:    run.createdAt,
    startedAt:    run.startedAt,
    finishedAt:   run.finishedAt,
    exitCode:     run.exitCode,
  };
}