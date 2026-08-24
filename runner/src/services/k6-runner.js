import { spawn } from 'child_process';
import { createWriteStream, watch as fsWatch } from 'fs';
import { mkdir, writeFile, access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateScript } from './script-generator.js';
import { getRun, updateStatus } from './run-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prefer the local k6 binary (built with xk6-dashboard); fall back to system k6
const LOCAL_K6 = path.resolve(__dirname, '../../../k6');
const K6_BIN = await access(LOCAL_K6).then(() => LOCAL_K6).catch(() => 'k6');
console.log(`[k6-runner] using binary: ${K6_BIN}`);

// Map of runId → ChildProcess, so we can send SIGINT on stop
const processes = new Map();

// Parse a k6 duration string (e.g. "1m30s", "300s", "2h") into milliseconds.
function parseDurationMs(d) {
  let ms = 0;
  const matches = String(d).matchAll(/(\d+)(h|m|s)/g);
  for (const [, val, unit] of matches) {
    if (unit === 'h') ms += parseInt(val) * 3600000;
    else if (unit === 'm') ms += parseInt(val) * 60000;
    else if (unit === 's') ms += parseInt(val) * 1000;
  }
  return ms || 60000; // fallback 60s if unparseable
}

// ─── Dashboard port pool ───────────────────────────────────────────────────────
const DASHBOARD_PORT_START = parseInt(process.env.K6_DASHBOARD_PORT_START || '5665', 10);
const DASHBOARD_PORT_COUNT = parseInt(process.env.K6_DASHBOARD_PORT_COUNT || '20',   10);
const portsInUse = new Set();

function allocateDashboardPort() {
  for (let i = 0; i < DASHBOARD_PORT_COUNT; i++) {
    const port = DASHBOARD_PORT_START + i;
    if (!portsInUse.has(port)) {
      portsInUse.add(port);
      return port;
    }
  }
  return null; // pool exhausted
}

function releaseDashboardPort(port) {
  if (port != null) portsInUse.delete(port);
}

/**
 * Starts a k6 process for the given run.
 * Writes the generated script to {run.dir}/script.js then spawns k6.
 *
 * @param {object} run - run record from run-store
 */
export async function startRun(run) {
  const { id, dir, config } = run;

  // Ensure the run output directory exists
  await mkdir(dir, { recursive: true });

  // Generate and write the k6 script
  const scriptPath = path.join(dir, 'script.js');
  const scriptSource = generateScript(config, dir);
  await writeFile(scriptPath, scriptSource, 'utf8');

  updateStatus(id, 'running');

  // Watch for summary.json — k6's handleSummary writes it once the test finishes.
  const summaryPath = path.join(dir, 'summary.json');
  const dirWatcher = fsWatch(dir, async (event, filename) => {
    if (filename !== 'summary.json') return;
    dirWatcher.close();
    try {
      await access(summaryPath);
      const currentRun = getRun(id);
      if (currentRun && currentRun.status === 'running') {
        updateStatus(id, 'finished');
      }
    } catch { /* file not ready yet — close event will handle it */ }
  });

  const dashboardExport = path.join(dir, 'dashboard.html');
  const k6Args = ['run'];

  let dashboardPort = null;
  if (run.dashboard) {
    dashboardPort = allocateDashboardPort();
    if (dashboardPort) {
      k6Args.push('--out', `web-dashboard=export=${dashboardExport}`);
      run.dashboardPort = dashboardPort;
    } else {
      console.warn(`[run ${id}] no dashboard ports available — starting without live dashboard`);
    }
  }

  // Stream raw metric data points so we can compute live stats during the run
  k6Args.push('--out', `json=${path.join(dir, 'metrics-stream.json')}`);
  k6Args.push(scriptPath);

  const k6 = spawn(K6_BIN, k6Args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      K6_WEB_DASHBOARD_HOST: '0.0.0.0',
      ...(dashboardPort ? { K6_WEB_DASHBOARD_PORT: String(dashboardPort) } : {}),
    },
  });

  processes.set(id, k6);

  // Watchdog — last-resort kill if k6 hangs during post-test cleanup
  const GRACEFUL_STOP_MS = 5000;
  const BUFFER_MS        = 120000;
  const watchdogMs = parseDurationMs(config.duration) + GRACEFUL_STOP_MS + BUFFER_MS;
  const watchdog = setTimeout(() => {
    if (processes.has(id)) {
      console.warn(`[run ${id}] watchdog triggered after ${watchdogMs}ms — force killing k6`);
      k6.kill('SIGKILL');
    }
  }, watchdogMs);

  // Stream stdout+stderr to stdout-live.txt as it arrives so the UI can poll it
  // during the run. stdout.txt is reserved for handleSummary's structured output on
  // completion; if that doesn't run (error), the route falls back to stdout-live.txt.
  const liveLogPath = path.join(dir, 'stdout-live.txt');
  const liveStream = createWriteStream(liveLogPath);

  k6.stdout.on('data', (chunk) => liveStream.write(chunk));
  k6.stderr.on('data', (chunk) => liveStream.write(chunk));

  k6.on('error', (err) => {
    // k6 binary not found or similar OS error
    console.error(`[run ${id}] spawn error:`, err.message);
    clearTimeout(watchdog);
    dirWatcher.close();
    liveStream.end();
    releaseDashboardPort(dashboardPort);
    updateStatus(id, 'failed', { exitCode: null });
    processes.delete(id);
  });

  k6.on('close', async (code, signal) => {
    clearTimeout(watchdog);
    dirWatcher.close();
    liveStream.end();
    releaseDashboardPort(dashboardPort);
    processes.delete(id);

    const currentRun = getRun(id);
    if (!currentRun) return;

    if (currentRun.status === 'stopping') {
      updateStatus(id, 'stopped', { exitCode: code });
    } else if (currentRun.status === 'running') {
      if (code === 0) {
        updateStatus(id, 'finished', { exitCode: 0 });
      } else {
        // Non-zero exit or SIGKILL — check if handleSummary still managed to write summary.json
        try {
          await access(summaryPath);
          updateStatus(id, 'finished', { exitCode: code });
        } catch {
          updateStatus(id, 'failed', { exitCode: code });
        }
      }
    } else {
      // Already in terminal state (set by summary.json watcher) — record exit code
      currentRun.exitCode = code;
    }

    console.log(`[run ${id}] exited — status: ${getRun(id)?.status}, code: ${code}, signal: ${signal}`);
  });
}

/**
 * Sends SIGINT to the k6 process to gracefully stop it.
 * k6 will still write handleSummary output before exiting.
 *
 * @param {string} runId
 */
export function stopRun(runId) {
  const run = getRun(runId);
  if (!run) return;

  updateStatus(runId, 'stopping');

  const proc = processes.get(runId);
  if (proc) {
    proc.kill('SIGINT');
  }
}