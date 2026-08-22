// Copyright (c) 2026 Stephen Ince
// Licensed under custom license. See LICENSE file.
// curl-load web UI — vanilla JS, no frameworks
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { runsRouter } from './src/routes/runs.js';
import { getRun, getActiveDashboardPort } from './src/services/run-store.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from file:// and any local dev origin (load-tester.html, etc.)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Serve the web UI as static files from ../web
app.use(express.static('../web'));
// Serve the load-tester workbench and its assets
app.use(express.static('../public'));

// ─── k6 live dashboard proxy ──────────────────────────────────────────────────
// Routes /runs/:id/dashboard/live/* → http://localhost:<dashboardPort>/*
// so k6's internal port never needs to be exposed externally.
const proxyByPort = new Map();

function getDashboardProxy(port) {
  if (!proxyByPort.has(port)) {
    proxyByPort.set(port, createProxyMiddleware({
      target: `http://localhost:${port}`,
      changeOrigin: true,
      on: {
        // Rewrite absolute redirect paths to stay inside the proxy prefix
        proxyRes: (proxyRes, req) => {
          const loc = proxyRes.headers.location;
          if (loc?.startsWith('/')) {
            const m = req.originalUrl?.match(/^(\/runs\/[^/?#]+\/dashboard\/live)/);
            if (m) proxyRes.headers.location = m[1] + loc;
          }
        },
        error: (_err, _req, res) => {
          if (res && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'live dashboard not available' }));
          }
        },
      },
    }));
  }
  return proxyByPort.get(port);
}

// Must be registered before runsRouter
app.use('/runs/:id/dashboard/live', (req, res, next) => {
  const run = getRun(req.params.id);
  if (!run?.dashboardPort) {
    return res.status(404).json({ error: 'live dashboard not available' });
  }
  if (!req.url) req.url = '/';
  return getDashboardProxy(run.dashboardPort)(req, res, next);
});

app.use('/runs', runsRouter);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Catch-all: proxy any unrecognised path to the active k6 dashboard.
// This transparently handles whatever absolute paths the dashboard SPA uses
// (/ui/*, /events, /api/*, etc.) without needing to enumerate them.
app.use((req, res, next) => {
  const port = getActiveDashboardPort();
  if (!port) return next();
  return getDashboardProxy(port)(req, res, next);
});

const server = app.listen(PORT, () => {
  console.log(`🚀 curl-load is running`);
  console.log(`👉 Workbench: http://localhost:${PORT}/load-tester.html`);
  console.log(`👉 Dashboard: http://localhost:${PORT}/`);
});

// Proxy WebSocket upgrades for the k6 live dashboard
server.on('upgrade', (req, socket, head) => {
  const m = req.url?.match(/\/runs\/([^/?#]+)\/dashboard\/live/);
  if (m) {
    const run = getRun(m[1]);
    if (!run?.dashboardPort) { socket.destroy(); return; }
    req.url = req.url.replace(/\/runs\/[^/?#]+\/dashboard\/live/, '') || '/';
    getDashboardProxy(run.dashboardPort).upgrade(req, socket, head);
    return;
  }
  // Catch-all: route any other WebSocket to the active k6 dashboard
  const port = getActiveDashboardPort();
  if (port) {
    getDashboardProxy(port).upgrade(req, socket, head);
    return;
  }
  socket.destroy();
});
