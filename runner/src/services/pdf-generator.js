import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { access } from 'fs/promises';
import path from 'path';

/**
 * Generates a PDF report for a completed run.
 * Page 1: styled metrics summary.
 * Page 2+: k6 dashboard (if dashboard.html exists for the run).
 *
 * Streams the final PDF directly into the Express response.
 *
 * @param {object} run         - run record from run-store (includes dir, config, startedAt, finishedAt)
 * @param {object} summaryData - parsed summary.json from k6
 * @param {object} res         - Express response (headers must not yet be sent)
 */
export async function buildRunPdf(run, summaryData) {
  const m    = summaryData.metrics || {};
  const http = m.http_req_duration?.values || {};
  const reqs = m.http_reqs?.values        || {};
  const errs = m.http_req_failed?.values  || {};

  const elapsedMs = (run.startedAt && run.finishedAt)
    ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
  const elapsed = elapsedMs != null
    ? (elapsedMs < 60000
        ? `${(elapsedMs / 1000).toFixed(1)} s`
        : `${Math.floor(elapsedMs / 60000)}m ${((elapsedMs % 60000) / 1000).toFixed(0)}s`)
    : '—';

  const fmt = (v, suffix = '') => v != null ? `${Number(v).toFixed(2)}${suffix}` : '—';
  const metrics = [
    ['Elapsed',        elapsed],
    ['Total requests', reqs.count ?? '—'],
    ['Req/s',          fmt(reqs.rate)],
    ['Latency avg',    fmt(http.avg,        ' ms')],
    ['Latency p95',    fmt(http['p(95)'],   ' ms')],
    ['Latency p99',    fmt(http['p(99)'],   ' ms')],
    ['Latency max',    fmt(http.max,        ' ms')],
    ['Error rate',     errs.rate != null ? `${(errs.rate * 100).toFixed(2)} %` : '—'],
  ];

  const metricsRows = metrics.map(([label, value]) => `
    <tr>
      <td>${label}</td>
      <td>${value}</td>
    </tr>`).join('');

  const startedStr  = run.startedAt  ? new Date(run.startedAt).toLocaleString()  : '—';
  const finishedStr = run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—';

  const summaryHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    padding: 64px;
    min-height: 100vh;
  }
  .header { margin-bottom: 48px; }
  .header h1 { font-size: 36px; color: #7dd3fc; margin-bottom: 10px; }
  .header .run-id { font-size: 15px; color: #475569; font-family: monospace; margin-bottom: 6px; }
  .header .generated { font-size: 15px; color: #475569; }

  .section { margin-bottom: 40px; }
  .section h2 { font-size: 18px; color: #64748b; text-transform: uppercase;
                letter-spacing: 0.08em; margin-bottom: 16px; }

  table { width: 100%; border-collapse: collapse; }
  td { padding: 12px 16px; font-size: 20px; }
  td:first-child { color: #94a3b8; width: 220px; }
  td:last-child  { color: #e2e8f0; font-family: monospace; font-weight: 600; }
  tr:nth-child(odd)  { background: #1e2330; }
  tr:nth-child(even) { background: #161b27; }

  .config-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 0;
  }
  .config-box {
    background: #1e2330;
    border-radius: 6px;
    padding: 16px 20px;
  }
  .config-label { font-size: 14px; color: #64748b; text-transform: uppercase;
                  letter-spacing: 0.06em; margin-bottom: 6px; }
  .config-value { font-size: 18px; color: #e2e8f0; font-family: monospace;
                  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
  <div class="header">
    <h1>curl-load &nbsp;/&nbsp; Load Test Report</h1>
    <div class="run-id">Run ID: ${run.id}</div>
    <div class="generated">Generated: ${new Date().toLocaleString()}</div>
  </div>

  <div class="section">
    <h2>Test Configuration</h2>
    <div class="config-grid">
      <div class="config-box">
        <div class="config-label">URL</div>
        <div class="config-value" title="${run.config.url}">${run.config.url}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Method</div>
        <div class="config-value">${run.config.method}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Virtual Users</div>
        <div class="config-value">${run.config.users}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Duration</div>
        <div class="config-value">${run.config.duration}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Started</div>
        <div class="config-value">${startedStr}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Finished</div>
        <div class="config-value">${finishedStr}</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Performance Metrics</h2>
    <table>
      <tbody>${metricsRows}</tbody>
    </table>
  </div>
</body>
</html>`;

  const dashboardPath = path.join(run.dir, 'dashboard.html');
  const hasDashboard = run.dashboard && await access(dashboardPath).then(() => true).catch(() => false);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let finalBytes;

  try {
    const page = await browser.newPage();

    // Render metrics summary page
    await page.setContent(summaryHtml, { waitUntil: 'networkidle0' });
    const summaryPdfBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    if (!hasDashboard) {
      finalBytes = Buffer.from(summaryPdfBytes);
    } else {
      // Render k6 dashboard — use 'load' since the HTML is self-contained
      await page.goto(`file://${dashboardPath}`, { waitUntil: 'load', timeout: 20000 });
      // Brief pause for chart rendering to settle
      await new Promise(r => setTimeout(r, 1500));
      const dashboardPdfBytes = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      });

      // Merge the two PDFs
      const merged       = await PDFDocument.create();
      const summaryDoc   = await PDFDocument.load(summaryPdfBytes);
      const dashboardDoc = await PDFDocument.load(dashboardPdfBytes);

      const summaryPages   = await merged.copyPages(summaryDoc,   summaryDoc.getPageIndices());
      const dashboardPages = await merged.copyPages(dashboardDoc, dashboardDoc.getPageIndices());

      summaryPages.forEach(p   => merged.addPage(p));
      dashboardPages.forEach(p => merged.addPage(p));

      finalBytes = Buffer.from(await merged.save());
    }
  } finally {
    await browser.close();
  }

  return finalBytes;
}
