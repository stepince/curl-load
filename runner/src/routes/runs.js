import { Router } from 'express';
import { createRun, getRun, listRuns, serializeRun, deleteRun } from '../services/run-store.js';
import { startRun, stopRun } from '../services/k6-runner.js';
import { buildRunPdf } from '../services/pdf-generator.js';
import { readFile } from 'fs/promises';
import path from 'path';

export const runsRouter = Router();

// GET /runs — list all runs, newest first
runsRouter.get('/', (req, res) => {
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
  const runs  = listRuns().slice(0, limit).map(serializeRun);
  res.json(runs);
});

// GET /runs/:id — full run metadata (no internal fields)
runsRouter.get('/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json(serializeRun(run));
});

// POST /runs — start a new load test
runsRouter.post('/', async (req, res) => {
  const { url, method, headers, body, users, duration, name, variables, pause, responseContentType, validationExpression } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  const run = createRun({ url, method, headers, body, users, duration, name, variables, pause, responseContentType, validationExpression });

  // Start k6 in the background — do not await
  startRun(run).catch((err) => {
    console.error(`Run ${run.id} failed to start:`, err.message);
  });

  res.status(202).json({ id: run.id, status: run.status });
});

// GET /runs/:id/status
runsRouter.get('/:id/status', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json({ id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt });
});

// GET /runs/:id/summary — returns parsed summary.json written by k6 handleSummary
runsRouter.get('/:id/summary', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const summaryPath = path.join(run.dir, 'summary.json');
  try {
    const raw = await readFile(summaryPath, 'utf8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'summary not available yet' });
  }
});

// GET /runs/:id/stdout — raw k6 output
// Returns stdout.txt (handleSummary's structured output) when available,
// falling back to stdout-live.txt (streamed during the run) otherwise.
runsRouter.get('/:id/stdout', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  for (const filename of ['stdout.txt', 'stdout-live.txt']) {
    try {
      const text = await readFile(path.join(run.dir, filename), 'utf8');
      return res.type('text/plain').send(text);
    } catch { /* try next */ }
  }
  res.status(404).json({ error: 'stdout not available yet' });
});

// GET /runs/:id/metrics — live metrics parsed from the --out json stream
runsRouter.get('/:id/metrics', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const streamPath = path.join(run.dir, 'metrics-stream.json');
  try {
    const raw = await readFile(streamPath, 'utf8');
    const durations = [];
    const durationPoints = []; // {time: ms epoch, value: ms}
    let reqCount = 0;
    let failCount = 0;

    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const pt = JSON.parse(line);
        if (pt.type !== 'Point') continue;
        if (pt.metric === 'http_req_duration') {
          durations.push(pt.data.value);
          durationPoints.push({ time: new Date(pt.data.time).getTime(), value: pt.data.value });
        } else if (pt.metric === 'http_reqs')    reqCount += pt.data.value;
        else if (pt.metric === 'http_req_failed' && pt.data.value > 0) failCount++;
      } catch { /* skip malformed lines */ }
    }

    durations.sort((a, b) => a - b);
    const avg = durations.length ? durations.reduce((s, v) => s + v, 0) / durations.length : null;
    const max = durations.length ? durations[durations.length - 1] : null;
    const p95 = durations.length ? durations[Math.floor(durations.length * 0.95)] : null;

    // Build 1-second buckets relative to the first data point
    const timeseries = [];
    if (durationPoints.length) {
      const origin = durationPoints[0].time;
      const buckets = new Map();
      for (const { time, value } of durationPoints) {
        const sec = Math.floor((time - origin) / 1000);
        if (!buckets.has(sec)) buckets.set(sec, []);
        buckets.get(sec).push(value);
      }
      for (const [sec, vals] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        const bucketAvg = vals.reduce((s, v) => s + v, 0) / vals.length;
        timeseries.push({ t: sec * 1000, v: Math.round(bucketAvg) });
      }
    }

    res.json({
      requests:   reqCount,
      avg:        avg  != null ? avg.toFixed(2)  : null,
      p95:        p95  != null ? p95.toFixed(2)  : null,
      max:        max  != null ? max.toFixed(2)  : null,
      errorRate:  reqCount > 0 ? ((failCount / reqCount) * 100).toFixed(2) : '0.00',
      timeseries,
    });
  } catch {
    res.status(404).json({ error: 'metrics not available yet' });
  }
});

// GET /runs/:id/dashboard — serve the exported k6 HTML dashboard report
runsRouter.get('/:id/dashboard', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  if (!run.dashboard) return res.status(404).json({ error: 'dashboard was not enabled for this run' });

  const dashboardPath = path.join(run.dir, 'dashboard.html');
  try {
    const html = await readFile(dashboardPath, 'utf8');
    res.type('text/html').send(html);
  } catch {
    res.status(404).json({ error: 'dashboard not available yet — run may still be in progress' });
  }
});

// GET /runs/:id/report.pdf — generate a PDF report (metrics summary + k6 dashboard)
runsRouter.get('/:id/report.pdf', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const summaryPath = path.join(run.dir, 'summary.json');
  let summaryData;
  try {
    summaryData = JSON.parse(await readFile(summaryPath, 'utf8'));
  } catch {
    return res.status(404).json({ error: 'summary not available — run may not be finished yet' });
  }

  try {
    const pdfBytes = await buildRunPdf(run, summaryData);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="curl-load-${run.id}.pdf"`);
    res.end(pdfBytes);
  } catch (err) {
    console.error(`[run ${run.id}] PDF generation failed:`, err.message);
    res.status(500).json({ error: 'PDF generation failed', detail: err.message });
  }
});

// DELETE /runs/:id — remove a finished/failed/stopped run
runsRouter.delete('/:id', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  if (['created', 'running', 'stopping'].includes(run.status)) {
    return res.status(409).json({ error: `cannot delete run in status: ${run.status}` });
  }
  await deleteRun(req.params.id);
  res.json({ id: req.params.id, deleted: true });
});

// POST /runs/:id/stop
runsRouter.post('/:id/stop', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  if (!['created', 'running'].includes(run.status)) {
    return res.status(409).json({ error: `cannot stop run in status: ${run.status}` });
  }

  stopRun(run.id);
  res.json({ id: run.id, status: run.status });
});