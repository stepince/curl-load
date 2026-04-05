// Copyright (c) 2026 Stephen Ince
// Licensed under custom license. See LICENSE file.
// curl-load web UI — vanilla JS, no frameworks
const API = '';

let currentRunId = null;
let varCounter = 0;
let pollInterval = null;
let historyPollInterval = null;
let outputMode = 'text';
let lastFinishedData = null;
let outputCollapsed = true;
const selectedRunIds = new Set();

const $ = (id) => document.getElementById(id);

$('runBtn').addEventListener('click', startTest);
$('stopBtn').addEventListener('click', stopTest);
$('refreshBtn').addEventListener('click', loadHistory);

// ─── New run ──────────────────────────────────────────────────────────────────

async function startTest() {
  const url      = $('url').value.trim();
  const name     = $('projectName').value.trim();
  const method   = $('method').value;
  const users    = parseInt($('users').value, 10) || 10;
  const duration = $('duration').value.trim() || '30s';
  const pause    = parseFloat($('pause').value) || 0;

  let headers = {};
  let body    = null;

  try {
    const raw = $('headers').value.trim();
    if (raw) headers = JSON.parse(raw);
  } catch {
    alert('Headers must be valid JSON.');
    return;
  }

  try {
    const raw = $('body').value.trim();
    if (raw) body = JSON.parse(raw);
  } catch {
    alert('Body must be valid JSON.');
    return;
  }

  if (!url) { alert('Please enter a URL.'); return; }

  $('runBtn').disabled = true;
  $('historyDetail').style.display = 'block';
  $('detailMetrics').innerHTML = '';
  $('detailOutput').textContent = 'Starting…';
  $('dashboardLink').style.display = 'none';
  $('pdfLink').style.display = 'none';
  lastFinishedData = null;

  try {
    const resp = await fetch(`${API}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, method, headers, body, users, duration, pause, variables: getVariableDefinitions() }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || resp.statusText);
    }

    const run = await resp.json();
    currentRunId = run.id;
    selectedRunIds.clear();
    selectedRunIds.add(run.id);

    setDetailUrl(name, url);
    setStatus(run.status);
    $('stopBtn').style.display = 'inline-block';
    showLiveDashboardLink();

    startPolling();
    loadHistory();
  } catch (err) {
    $('detailOutput').textContent = `Error: ${err.message}`;
    $('runBtn').disabled = false;
  }
}

async function stopTest() {
  if (!currentRunId) return;
  $('stopBtn').disabled = true;
  await fetch(`${API}/runs/${currentRunId}/stop`, { method: 'POST' }).catch(() => {});
}

// ─── Active run polling ───────────────────────────────────────────────────────

function startPolling() {
  pollInterval = setInterval(async () => {
    if (!currentRunId) return;

    try {
      const r = await fetch(`${API}/runs/${currentRunId}/status`);
      const { status, startedAt } = await r.json();
      setStatus(status);

      if (['running', 'stopping'].includes(status)) {
        try {
          const mr = await fetch(`${API}/runs/${currentRunId}/metrics`);
          if (mr.ok) {
            const elapsedSec = startedAt ? (Date.now() - new Date(startedAt).getTime()) / 1000 : null;
            $('detailOutput').textContent = formatLiveMetrics(await mr.json(), elapsedSec);
          }
        } catch { /* transient */ }
      }

      if (['finished', 'failed', 'stopped'].includes(status)) {
        clearInterval(pollInterval);
        $('runBtn').disabled = false;
        $('stopBtn').style.display = 'none';
        await loadOutput(status);
        loadHistory(); // refresh list once done
      }
    } catch { /* transient — keep polling */ }
  }, 1500);
}

async function loadOutput(status) {
  lastFinishedData = null;
  if (status === 'finished' || status === 'stopped') {
    try {
      const [sr, rr, stdr] = await Promise.all([
        fetch(`${API}/runs/${currentRunId}/summary`),
        fetch(`${API}/runs/${currentRunId}`),
        fetch(`${API}/runs/${currentRunId}/stdout`),
      ]);
      if (sr.ok) {
        const data   = await sr.json();
        const run    = rr.ok   ? await rr.json()   : {};
        const stdout = stdr.ok ? await stdr.text()  : null;
        const elapsedMs = (run.startedAt && run.finishedAt)
          ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
        const dashboardReport = run.dashboardReport || null;
        lastFinishedData = { runId: currentRunId, data, elapsedMs, stdout, dashboardReport };
        renderOutput();
        return;
      }
    } catch { /* fall through */ }
  }
  try {
    const r = await fetch(`${API}/runs/${currentRunId}/stdout`);
    if (r.ok) { $('detailOutput').textContent = await r.text(); return; }
  } catch { /* fall through */ }
  $('detailOutput').textContent = 'No output available.';
}

// ─── Run history ──────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const r = await fetch(`${API}/runs?limit=50`);
    if (!r.ok) return;
    const runs = await r.json();
    renderHistory(runs);

    // If there's a run in progress that we don't know about (started externally),
    // populate the form so the dashboard reflects what's running
    const activeRun = runs.find(r => ['created', 'running'].includes(r.status));
    if (activeRun && activeRun.id !== currentRunId) {
      currentRunId = activeRun.id;
      selectedRunIds.clear();
      selectedRunIds.add(activeRun.id);
      populateForm(activeRun);
      $('historyDetail').style.display = 'block';
      $('compareDetail').style.display = 'none';
      setDetailUrl(activeRun.config?.name, activeRun.config?.url);
      setStatus(activeRun.status);
      $('runBtn').disabled = true;
      $('stopBtn').style.display = 'inline-block';
      $('detailOutput').textContent = 'Run in progress…';
      showLiveDashboardLink();
      startPolling();
    }
  } catch { /* network error */ }
}

function populateForm(run) {
  const c = run.config || {};
  $('projectName').value = c.name     || '';
  $('url').value         = c.url      || '';
  $('users').value       = c.users    ?? 10;
  $('duration').value    = c.duration || '30s';
  $('pause').value       = c.pause    ?? 1;
  $('headers').value     = c.headers && Object.keys(c.headers).length
    ? JSON.stringify(c.headers, null, 2) : '';
  $('body').value        = c.body
    ? JSON.stringify(c.body, null, 2) : '';
  const methodEl = $('method');
  [...methodEl.options].forEach(o => { o.selected = o.value === c.method; });
  $('variables').innerHTML = '';
  varCounter = 0;
  Object.entries(c.variables || {}).forEach(([name, def]) => {
    addVariable(name, (def.values || []).join(', '), def.type);
  });
}

function renderHistory(runs) {
  const list = $('historyList');

  if (runs.length === 0) {
    list.innerHTML = '<li style="color:#475569; font-size:0.85rem;">No runs yet.</li>';
    return;
  }

  list.innerHTML = runs.map((run) => {
    const name    = run.config?.name || '';
    const url     = run.config?.url  || '—';
    const vus     = run.config?.users    ?? '?';
    const dur     = formatConfigDuration(run.config?.duration);
    const timeStr = run.startedAt
      ? new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : formatElapsed(run.createdAt);
    const checked = selectedRunIds.has(run.id) ? 'checked' : '';
    const active  = selectedRunIds.has(run.id) ? 'active'  : '';

    return `
      <li class="run-row ${active}" data-id="${run.id}">
        <input type="checkbox" class="run-checkbox" data-id="${run.id}" ${checked}
               onclick="handleCheckboxChange('${run.id}', this.checked)" />
        <span class="status-badge status-${run.status}">${run.status}</span>
        <div class="run-row-info run-row-label" onclick="focusRun('${run.id}')">
          ${name ? `<div class="run-row-name">${name}</div>` : ''}
          <div class="run-row-url" title="${url}">${url}</div>
        </div>
        <span class="run-row-meta run-row-label" onclick="focusRun('${run.id}')">${vus}vu · ${dur}<br>${timeStr}</span>
        <button title="${['created','running','stopping'].includes(run.status) ? 'Stop and delete run' : 'Delete run'}" style="background:none; border:none; color:#ef4444; opacity:0.6; padding:0 0.25rem; cursor:pointer; line-height:1; flex-shrink:0;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6"
            onclick="deleteRun('${run.id}')"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
      </li>`;
  }).join('');
}

function handleCheckboxChange(id, checked) {
  if (checked) selectedRunIds.add(id);
  else          selectedRunIds.delete(id);

  document.querySelectorAll('.run-row').forEach(el => {
    el.classList.toggle('active', selectedRunIds.has(el.dataset.id));
  });

  if (selectedRunIds.size === 0) {
    $('historyDetail').style.display = 'none';
    $('compareDetail').style.display = 'none';
  } else if (selectedRunIds.size === 1) {
    $('compareDetail').style.display = 'none';
    selectRun([...selectedRunIds][0]);
  } else {
    $('historyDetail').style.display = 'none';
    renderCompareDetail([...selectedRunIds]);
  }
}

let _loadIntoFormId = null;

function loadIntoForm(id) {
  _loadIntoFormId = id;
  fetch(`${API}/runs/${id}`)
    .then(r => r.json())
    .then(data => {
      if (_loadIntoFormId !== id) return;
      const c = data.config || {};
      $('projectName').value = c.name     || '';
      $('url').value         = c.url      || '';
      $('users').value    = c.users    ?? 10;
      $('duration').value = c.duration || '30s';
      $('pause').value    = c.pause    ?? 1;
      $('headers').value  = Object.keys(c.headers || {}).length
        ? JSON.stringify(c.headers, null, 2) : '';
      $('body').value     = c.body
        ? JSON.stringify(c.body, null, 2) : '';

      // Restore variables
      $('variables').innerHTML = '';
      varCounter = 0;
      Object.entries(c.variables || {}).forEach(([name, def]) => {
        addVariable(name, (def.values || []).join(', '), def.type);
      });

      // Select the matching method option
      const methodEl = $('method');
      [...methodEl.options].forEach(o => { o.selected = o.value === c.method; });

      // Re-expand textareas after programmatic fill
      document.querySelectorAll('textarea').forEach(ta => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });

      // Scroll form into view
      $('url').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('url').focus();
    })
    .catch(() => {});
}

function focusRun(id) {
  // Clear all selections and show only this run's detail
  selectedRunIds.clear();
  selectedRunIds.add(id);
  document.querySelectorAll('.run-checkbox').forEach(cb => {
    cb.checked = cb.dataset.id === id;
  });
  document.querySelectorAll('.run-row').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  $('compareDetail').style.display = 'none';
  loadIntoForm(id);
  selectRun(id);
}

async function selectRun(id) {
  $('compareDetail').style.display = 'none';
  $('historyDetail').style.display = 'block';
  $('detailOutput').textContent = 'Loading…';
  $('detailMetrics').innerHTML = '';

  // Fetch run metadata
  try {
    const r = await fetch(`${API}/runs/${id}`);
    const run = await r.json();
    $('projectName').value = run.config?.name || '';
    setDetailUrl(run.config?.name, run.config?.url);

    // Show key config metrics
    renderDetailMetrics([
      ['VUs',      run.config?.users],
      ['Duration', formatConfigDuration(run.config?.duration)],
      ['Method',   run.config?.method],
      ['Status',   run.status],
      ['Started',  run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : '—'],
      ['Finished', run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString() : '—'],
    ]);
  } catch { /* ignore */ }

  // Try summary + stdout, then stdout only
  const terminal = ['finished', 'stopped'];
  try {
    const sr = await fetch(`${API}/runs/${id}/status`);
    const { status } = await sr.json();

    if (terminal.includes(status)) {
      try {
        const [summaryR, runR, stdoutR] = await Promise.all([
          fetch(`${API}/runs/${id}/summary`),
          fetch(`${API}/runs/${id}`),
          fetch(`${API}/runs/${id}/stdout`),
        ]);
        if (summaryR.ok) {
          const data   = await summaryR.json();
          const run    = runR.ok    ? await runR.json()    : {};
          const stdout = stdoutR.ok ? await stdoutR.text() : null;
          const elapsedMs = (run.startedAt && run.finishedAt)
            ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
          renderDetailMetrics(summaryMetrics(data, elapsedMs), true);
          const dashboardReport = run.dashboardReport || null;
          lastFinishedData = { runId: id, data, elapsedMs, stdout, dashboardReport };
          renderOutput();
          return;
        }
      } catch { /* fall through */ }
    }

    const r = await fetch(`${API}/runs/${id}/stdout`);
    $('detailOutput').textContent = r.ok ? await r.text() : 'No output yet.';
  } catch {
    $('detailOutput').textContent = 'Failed to load output.';
  }
}

function renderDetailMetrics(pairs, append = false) {
  const grid = $('detailMetrics');
  if (!append) grid.innerHTML = '';
  pairs.forEach(([label, value]) => {
    const box = document.createElement('div');
    box.className = 'metric-box';
    box.innerHTML = `<div class="metric-label">${label}</div><div class="metric-value">${value ?? '—'}</div>`;
    grid.appendChild(box);
  });
}

function summaryMetrics(data, elapsedMs = null) {
  const m    = data.metrics || {};
  const http = m.http_req_duration?.values || {};
  const reqs = m.http_reqs?.values || {};
  const errs = m.http_req_failed?.values || {};
  const elapsed = elapsedMs != null
    ? (elapsedMs < 60000
        ? `${(elapsedMs / 1000).toFixed(1)} s`
        : `${Math.floor(elapsedMs / 60000)}m ${((elapsedMs % 60000) / 1000).toFixed(0)}s`)
    : null;
  return [
    ...(elapsed ? [['Elapsed', elapsed]] : []),
    ['Total Requests', reqs.count],
    ['Req/s',          reqs.rate?.toFixed(1)],
    ['Avg Latency',    http.avg    ? `${http.avg.toFixed(0)} ms`       : '—'],
    ['p95 Latency',    http['p(95)'] ? `${http['p(95)'].toFixed(0)} ms` : '—'],
    ['p99 Latency',    http['p(99)'] ? `${http['p(99)'].toFixed(0)} ms` : '—'],
    ['Error Rate',     errs.rate != null ? `${(errs.rate * 100).toFixed(2)} %` : '—'],
  ];
}

// Parse a k6 duration string ("30s", "5m", "1h30m", "300s") into total seconds
function parseDurationSec(str) {
  if (!str) return null;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s|ms)/g;
  let match;
  while ((match = re.exec(str)) !== null) {
    const v = parseFloat(match[1]);
    if (match[2] === 'h')  total += v * 3600;
    else if (match[2] === 'm')  total += v * 60;
    else if (match[2] === 's')  total += v;
    else if (match[2] === 'ms') total += v / 1000;
  }
  return total || null;
}

function formatConfigDuration(str) {
  const sec = parseDurationSec(str);
  if (sec == null) return str || '—';
  if (sec < 60) return `${sec % 1 === 0 ? sec : sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s.toFixed(0)}s`;
}

// ─── Variables ───────────────────────────────────────────────────────────────

function addVariable(name = '', values = '', type = 'constant') {
  const idx = ++varCounter;
  const div = document.createElement('div');
  div.className = 'variable-row';
  div.innerHTML = `
    <input id="varName_${idx}" placeholder="Name" value="${name}" style="flex:1;" />
    <input id="varValue_${idx}" class="variable-value" placeholder="Values (comma or newline)" value="${values}" style="flex:2;" />
    <select id="varType_${idx}" class="variable-type" style="width:110px;">
      <option value="constant"${type==='constant'?' selected':''}>Constant</option>
      <option value="sequential"${type==='sequential'?' selected':''}>Sequential</option>
      <option value="random"${type==='random'?' selected':''}>Random</option>
    </select>
    <button onclick="this.closest('.variable-row').remove()" title="Remove variable"
      style="background:none; border:none; color:#ef4444; opacity:0.6; padding:0 0.25rem; cursor:pointer; line-height:1; flex-shrink:0; align-self:flex-end;"
      onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
    </button>
  `;
  $('variables').appendChild(div);
}

function getVariableDefinitions() {
  const vars = {};
  document.querySelectorAll('.variable-row').forEach(row => {
    const name   = row.querySelector('[id^="varName_"]')?.value.trim();
    const values = row.querySelector('.variable-value')?.value
      .split(/[\n,]/).map(v => v.trim()).filter(Boolean);
    const type   = row.querySelector('.variable-type')?.value || 'constant';
    if (name && values?.length) vars[name] = { type, values };
  });
  return vars;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatReport(data, elapsedMs = null) {
  const m    = data.metrics || {};
  const http = m.http_req_duration?.values || {};
  const reqs = m.http_reqs?.values || {};
  const errs = m.http_req_failed?.values || {};

  const lines = [];
  if (elapsedMs != null) {
    const elapsed = elapsedMs < 60000
      ? `${(elapsedMs / 1000).toFixed(1)} s`
      : `${Math.floor(elapsedMs / 60000)}m ${((elapsedMs % 60000) / 1000).toFixed(0)}s`;
    lines.push(`Elapsed        : ${elapsed}`);
  }
  if (reqs.count    != null) lines.push(`Total requests : ${reqs.count}`);
  if (reqs.rate     != null) lines.push(`Req/s          : ${reqs.rate.toFixed(2)}`);
  if (http.avg      != null) lines.push(`Latency avg    : ${http.avg.toFixed(2)} ms`);
  if (http['p(95)'] != null) lines.push(`Latency p95    : ${http['p(95)'].toFixed(2)} ms`);
  if (http['p(99)'] != null) lines.push(`Latency p99    : ${http['p(99)'].toFixed(2)} ms`);
  if (http.max      != null) lines.push(`Latency max    : ${http.max.toFixed(2)} ms`);
  if (errs.rate     != null) lines.push(`Error rate     : ${(errs.rate * 100).toFixed(2)} %`);

  return lines.join('\n');
}

function setDetailUrl(name, url = '') {
  $('detailUrl').innerHTML = name
    ? `<span style="font-size:0.88rem; font-weight:600; color:#e2e8f0; display:block; margin-bottom:0.2rem;">${name}</span><span>${url}</span>`
    : url;
}

function showLiveDashboardLink() {
  const link = $('dashboardLink');
  link.href = `http://${window.location.hostname}:5665`;
  link.style.display = 'inline';
}

function setStatus(status) {
  const el = $('status');
  el.textContent = status;
  el.className = `status-badge status-${status}`;
  el.style.display = 'inline-block';
}

function setOutputMode(mode) {
  outputMode = mode;
  $('modeTextBtn').style.background = mode === 'text' ? '#3b82f6' : '#475569';
  $('modeJsonBtn').style.background = mode === 'json' ? '#3b82f6' : '#475569';
  if (mode === 'text') {
    $('outputToggleBtn').textContent = outputCollapsed ? '▼' : '▲';
  }
  if (lastFinishedData) renderOutput();
}

function toggleOutput() {
  if (outputMode === 'json') return;
  outputCollapsed = !outputCollapsed;
  $('outputToggleBtn').textContent = outputCollapsed ? '▼' : '▲';
  renderOutput();
}

function renderOutput() {
  if (!lastFinishedData) return;
  const { data, elapsedMs, stdout, dashboardReport } = lastFinishedData;
  const isJson = outputMode === 'json';

  // Collapse toggle is disabled in JSON mode
  $('outputToggleBtn').disabled = isJson;
  $('outputToggleBtn').style.opacity = isJson ? '0.3' : '1';
  $('outputToggleBtn').style.cursor  = isJson ? 'not-allowed' : 'pointer';

  if (isJson) {
    $('detailOutput').textContent = JSON.stringify(data, null, 2);
  } else if (outputCollapsed) {
    $('detailOutput').textContent = formatReport(data, elapsedMs);
  } else {
    $('detailOutput').textContent =
      formatReport(data, elapsedMs) + '\n\n--- full summary (TEXT) ---\n' + (stdout || 'No text output available.');
  }
  const link = $('dashboardLink');
  if (dashboardReport) {
    link.href = dashboardReport;
    link.style.display = 'inline';
  } else {
    link.style.display = 'none';
  }

  const pdfLink = $('pdfLink');
  if (lastFinishedData?.runId) {
    pdfLink.style.display = 'inline';
    pdfLink.onclick = (e) => {
      e.preventDefault();
      if (pdfLink.dataset.loading) return;
      pdfLink.dataset.loading = '1';
      pdfLink.style.color = '#64748b';
      pdfLink.style.pointerEvents = 'none';
      let dotCount = 0;
      const dotTimer = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        pdfLink.textContent = 'Generating PDF' + '.'.repeat(dotCount);
      }, 500);
      fetch(`/runs/${lastFinishedData.runId}/report.pdf`)
        .then(r => r.ok ? r.blob() : Promise.reject())
        .then(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `curl-load-${lastFinishedData.runId}.pdf`;
          a.click();
          URL.revokeObjectURL(url);
        })
        .catch(() => {})
        .finally(() => {
          clearInterval(dotTimer);
          delete pdfLink.dataset.loading;
          pdfLink.textContent = 'Download PDF ↓';
          pdfLink.style.color = '#94a3b8';
          pdfLink.style.pointerEvents = '';
        });
    };
  } else {
    pdfLink.style.display = 'none';
  }
}

function copyReport(btn) {
  const text = $('detailOutput').textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const origBg = btn.style.background;
    btn.style.background = "url('data:image/svg+xml;charset=utf-8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2215%22><path fill=%22%2300aa00%22 d=%22M13.5 2l-7.5 7.5-3.5-3.5L1 7.5 6 12.5 15 3.5z%22/></svg>') 50% no-repeat";
    setTimeout(() => { btn.style.background = origBg; }, 1500);
  });
}

function formatElapsed(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ─── Live progress parser ─────────────────────────────────────────────────────

function formatLiveMetrics(m, elapsedSec) {
  const elapsed = elapsedSec != null
    ? (elapsedSec < 60
        ? `${elapsedSec.toFixed(1)}s`
        : `${Math.floor(elapsedSec / 60)}m ${(elapsedSec % 60).toFixed(0)}s`)
    : '—';
  const rps     = (m.requests && elapsedSec > 0) ? (m.requests / elapsedSec).toFixed(2) : '—';
  return [
    `Elapsed        : ${elapsed}`,
    `Total requests : ${m.requests ?? '—'}`,
    `Req/s          : ${rps}`,
    `Latency avg    : ${m.avg  != null ? m.avg  + ' ms' : '—'}`,
    `Latency p95    : ${m.p95  != null ? m.p95  + ' ms' : '—'}`,
    `Latency max    : ${m.max  != null ? m.max  + ' ms' : '—'}`,
    `Error rate     : ${m.errorRate != null ? m.errorRate + ' %' : '—'}`,
  ].join('\n');
}

// ─── Comparison view ─────────────────────────────────────────────────────────

async function renderCompareDetail(ids) {
  $('compareDetail').style.display = 'block';
  $('compareGrid').innerHTML = '<span style="color:#475569; font-size:0.85rem;">Loading…</span>';

  const results = await Promise.all(ids.map(async id => {
    try {
      const [runR, statusR] = await Promise.all([
        fetch(`${API}/runs/${id}`),
        fetch(`${API}/runs/${id}/status`),
      ]);
      const run    = runR.ok    ? await runR.json()    : {};
      const { status } = statusR.ok ? await statusR.json() : {};
      let summaryData = null, elapsedMs = null;
      if (['finished', 'stopped'].includes(status)) {
        const sr = await fetch(`${API}/runs/${id}/summary`);
        if (sr.ok) {
          summaryData = await sr.json();
          elapsedMs = (run.startedAt && run.finishedAt)
            ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
        }
      }
      return { id, run, status, summaryData, elapsedMs };
    } catch {
      return { id, run: {}, status: 'error', summaryData: null, elapsedMs: null };
    }
  }));

  $('compareGrid').innerHTML = results.map(renderCompareCard).join('');
}

function renderCompareCard({ id, run, status, summaryData, elapsedMs }) {
  const name   = run.config?.name     || '';
  const url    = run.config?.url      || '—';
  const vus    = run.config?.users    ?? '?';
  const dur    = run.config?.duration ?? '?';
  const method = run.config?.method   || '';
  const timeStr = run.startedAt
    ? new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  const box = (label, value) =>
    `<div class="metric-box"><div class="metric-label">${label}</div><div class="metric-value">${value ?? '—'}</div></div>`;

  const metricPairs = summaryData
    ? [['Started', timeStr], ...summaryMetrics(summaryData, elapsedMs)]
    : [['Started', timeStr]];

  const metricsHtml = `<div class="metric-grid" style="margin-top:0.65rem;">${metricPairs.map(([l, v]) => box(l, v)).join('')}</div>`;

  return `
    <div class="compare-card">
      ${name ? `<div class="compare-card-name">${name}</div>` : ''}
      <div class="compare-card-url" title="${url}">${url}</div>
      <div style="display:flex; align-items:center; justify-content:space-between; margin-top:0.35rem;">
        <span class="compare-card-meta">${method} · ${vus}vu · ${dur}</span>
        <span class="status-badge status-${status}">${status}</span>
      </div>
      ${metricsHtml}
    </div>`;
}

async function deleteRun(id) {
  try {
    // Check current status
    const sr = await fetch(`${API}/runs/${id}/status`);
    const { status } = sr.ok ? await sr.json() : {};
    const isActive = ['created', 'running', 'stopping'].includes(status);

    if (!confirm(isActive ? 'Stop and delete this run?' : 'Delete this run?')) return;

    // Stop first if active, then wait until terminal
    if (isActive) {
      await fetch(`${API}/runs/${id}/stop`, { method: 'POST' }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const pr = await fetch(`${API}/runs/${id}/status`);
        const { status: s } = pr.ok ? await pr.json() : {};
        if (['finished', 'failed', 'stopped'].includes(s)) break;
      }
    }

    const r = await fetch(`${API}/runs/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(err.error || 'Failed to delete run');
      return;
    }
    selectedRunIds.delete(id);
    if (currentRunId === id) currentRunId = null;
    if (selectedRunIds.size === 0) {
      $('historyDetail').style.display = 'none';
      $('compareDetail').style.display = 'none';
    } else if (selectedRunIds.size === 1) {
      $('compareDetail').style.display = 'none';
      selectRun([...selectedRunIds][0]);
    } else {
      renderCompareDetail([...selectedRunIds]);
    }
    await loadHistory();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadHistory();
// Refresh history every 5s to catch runs started via CLI or API
historyPollInterval = setInterval(loadHistory, 5000);