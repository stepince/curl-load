// Copyright (c) 2026 Stephen Ince
// Licensed under custom license. See LICENSE file.
// curl-load web UI — vanilla JS, no frameworks
import express from 'express';
import { runsRouter } from './src/routes/runs.js';

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

app.use('/runs', runsRouter);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`🚀 curl-load is running`);
  console.log(`👉 Workbench: http://localhost:${PORT}/load-tester.html`);
  console.log(`👉 Dashboard: http://localhost:${PORT}/`);
});
