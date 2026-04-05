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

  // Watch for summary.json — k6's handleSummary writes it the moment the test
  // finishes, before the dashboard HTML is exported.  Updating status here means
  // the UI reflects "finished" promptly without waiting for the export to complete.
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
  if (run.dashboard) {
    k6Args.push('--out', `web-dashboard=export=${dashboardExport}`);
  }
  // Stream raw metric data points so we can compute live stats during the run
  k6Args.push('--out', `json=${path.join(dir, 'metrics-stream.json')}`);
  k6Args.push(scriptPath);

  const k6 = spawn(K6_BIN, k6Args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Bind dashboard to all interfaces so remote browsers can reach it
    env: { ...process.env, K6_WEB_DASHBOARD_HOST: '0.0.0.0' },
  });

  processes.set(id, k6);

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
    dirWatcher.close();
    liveStream.end();
    updateStatus(id, 'failed', { exitCode: null });
    processes.delete(id);
  });

  k6.on('close', async (code, signal) => {
    dirWatcher.close();
    liveStream.end();
    processes.delete(id);

    const currentRun = getRun(id);
    if (!currentRun) return;

    if (currentRun.status === 'stopping') {
      updateStatus(id, 'stopped', { exitCode: code });
    } else if (currentRun.status === 'running') {
      // summary.json watcher didn't fire — test ended without writing summary
      if (code === 0) {
        updateStatus(id, 'finished', { exitCode: 0 });
      } else {
        updateStatus(id, 'failed', { exitCode: code });
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