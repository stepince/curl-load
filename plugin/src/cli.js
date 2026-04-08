#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('curl-load')
  .description('Run k6 load tests via the curl-load runner API')
  .version('0.1.0');

program
  .command('run')
  .description('Start a load test and print the summary')
  .requiredOption('--url <url>', 'Target URL')
  .option('--method <method>', 'HTTP method', 'GET')
  .option('--users <n>', 'Number of virtual users', '10')
  .option('--duration <d>', 'Test duration (k6 format, e.g. 30s)', '30s')
  .option('--header <header...>', 'Request headers in "Key: Value" format')
  .option('--body <json>', 'Request body as a JSON string')
  .option('--runner <url>', 'Runner API base URL', 'http://localhost:3000')
  .action(async (opts) => {
    const headers = parseHeaders(opts.header || []);
    let body = null;

    if (opts.body) {
      try {
        body = JSON.parse(opts.body);
      } catch {
        console.error('Error: --body must be valid JSON');
        process.exit(1);
      }
    }

    const payload = {
      url: opts.url,
      method: opts.method.toUpperCase(),
      headers,
      body,
      users: parseInt(opts.users, 10),
      duration: opts.duration,
    };

    console.log(`\nStarting load test against ${opts.url}`);
    console.log(`  VUs: ${payload.users}  Duration: ${payload.duration}\n`);

    // Submit the run
    let runId;
    try {
      const resp = await fetch(`${opts.runner}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || resp.statusText);
      }

      const run = await resp.json();
      runId = run.id;
      console.log(`Run ID : ${runId}`);
    } catch (err) {
      console.error(`Failed to start run: ${err.message}`);
      process.exit(1);
    }

    // Poll until terminal state
    await pollUntilDone(opts.runner, runId);
  });

program
  .command('rerun <runId>')
  .description('Re-execute a previous run by ID, optionally overriding execution parameters')
  .option('--users <n>',      'Override number of virtual users')
  .option('--duration <d>',   'Override test duration (k6 format, e.g. 30s)')
  .option('--pause <n>',      'Override pause between requests (seconds)')
  .option('--runner <url>',   'Runner API base URL', 'http://localhost:3000')
  .action(async (runId, opts) => {
    // Fetch original run config
    let config;
    try {
      const r = await fetch(`${opts.runner}/runs/${runId}`);
      if (!r.ok) throw new Error(`Run not found: ${runId}`);
      const run = await r.json();
      config = run.config;
    } catch (err) {
      console.error(`Failed to fetch run ${runId}: ${err.message}`);
      process.exit(1);
    }

    // Apply overrides
    if (opts.users)    config.users    = parseInt(opts.users, 10);
    if (opts.duration) config.duration = opts.duration;
    if (opts.pause)    config.pause    = parseFloat(opts.pause);

    // Start new run
    let newRunId;
    try {
      const r = await fetch(`${opts.runner}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || r.statusText);
      }
      newRunId = (await r.json()).id;
    } catch (err) {
      console.error(`Failed to start run: ${err.message}`);
      process.exit(1);
    }

    process.stderr.write(`Rerunning ${runId} → new run ${newRunId}\n`);
    process.stderr.write(`VUs: ${config.users}  Duration: ${config.duration}\n`);

    await pollUntilDone(opts.runner, newRunId, true);
  });

program.parse();

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses ["Content-Type: application/json", "Authorization: Bearer x"] into an object.
 */
function parseHeaders(headerArgs) {
  const out = {};
  for (const h of headerArgs) {
    const idx = h.indexOf(':');
    if (idx === -1) continue;
    const key = h.slice(0, idx).trim();
    const val = h.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

/**
 * Poll /runs/:id/status until finished | failed | stopped, then print summary.
 * @param {boolean} jsonOutput - when true, write JSON to stdout; progress to stderr
 */
async function pollUntilDone(runner, runId, jsonOutput = false) {
  const TERMINAL = new Set(['finished', 'failed', 'stopped']);
  const progress = jsonOutput ? process.stderr : process.stdout;

  progress.write('Running ');

  while (true) {
    await sleep(1500);
    progress.write('.');

    let status;
    try {
      const r = await fetch(`${runner}/runs/${runId}/status`);
      ({ status } = await r.json());
    } catch {
      continue; // transient error, keep polling
    }

    if (TERMINAL.has(status)) {
      progress.write(` ${status}\n\n`);
      await printSummary(runner, runId, status, jsonOutput);
      return;
    }
  }
}

async function printSummary(runner, runId, status, jsonOutput = false) {
  if (status === 'finished' || status === 'stopped') {
    try {
      const r = await fetch(`${runner}/runs/${runId}/summary`);
      if (r.ok) {
        const data = await r.json();
        if (jsonOutput) {
          console.log(JSON.stringify(buildJsonSummary(runId, status, data), null, 2));
        } else {
          printMetrics(data);
        }
        return;
      }
    } catch { /* fall through */ }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ runId, status, metrics: null }));
    return;
  }

  // Fall back to raw stdout
  try {
    const r = await fetch(`${runner}/runs/${runId}/stdout`);
    if (r.ok) {
      console.log(await r.text());
      return;
    }
  } catch { /* fall through */ }

  console.log('No output available.');
}

function buildJsonSummary(runId, status, data) {
  const metrics = data.metrics || {};
  const http    = metrics.http_req_duration?.values || {};
  const reqs    = metrics.http_reqs?.values || {};
  const errors  = metrics.http_req_failed?.values || {};

  return {
    runId,
    status,
    metrics: {
      totalRequests: reqs.count    ?? null,
      rps:           reqs.rate     ?? null,
      latencyAvg:    http.avg      ?? null,
      latencyP95:    http['p(95)'] ?? null,
      latencyP99:    http['p(99)'] ?? null,
      latencyMax:    http.max      ?? null,
      errorRate:     errors.rate   ?? null,
    },
  };
}

function printMetrics(data) {
  const metrics = data.metrics || {};
  const http    = metrics.http_req_duration?.values || {};
  const reqs    = metrics.http_reqs?.values || {};
  const errors  = metrics.http_req_failed?.values || {};

  const line = (label, value) => console.log(`  ${label.padEnd(20)} ${value}`);

  console.log('─── Summary ───────────────────────────────────');
  if (reqs.count  !== undefined) line('Total requests',  reqs.count);
  if (reqs.rate   !== undefined) line('Req/s',           reqs.rate?.toFixed(2));
  if (http.avg    !== undefined) line('Latency avg',     `${http.avg?.toFixed(2)} ms`);
  if (http['p(95)'] !== undefined) line('Latency p95',   `${http['p(95)']?.toFixed(2)} ms`);
  if (http['p(99)'] !== undefined) line('Latency p99',   `${http['p(99)']?.toFixed(2)} ms`);
  if (http.max    !== undefined) line('Latency max',     `${http.max?.toFixed(2)} ms`);
  if (errors.rate !== undefined) line('Error rate',      `${(errors.rate * 100).toFixed(2)} %`);
  console.log('───────────────────────────────────────────────\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}