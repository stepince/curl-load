# curl-load — Architecture

## Components

```
curl-load/
├── runner/           Node.js + Express API — manages k6 processes
│   ├── server.js
│   ├── src/
│   │   ├── routes/runs.js          REST endpoints
│   │   └── services/
│   │       ├── run-store.js        In-memory run registry
│   │       ├── k6-runner.js        spawn / stop k6
│   │       └── script-generator.js Generate k6 scripts from config
│   ├── runs/                       Created at runtime — one dir per run ID
│   └── Dockerfile
├── web/              Single-page UI (no framework)
│   ├── index.html
│   └── app.js
└── plugin/           Node CLI (commander)
    └── src/cli.js
```

## Request flow

```
CLI / Web UI
     │  POST /runs  { url, method, headers, body, users, duration }
     ▼
runner/server.js
     │
     ├─ run-store.createRun()      allocate ID, set status=created
     │
     ├─ script-generator()         render k6 script to runs/{id}/script.js
     │
     └─ k6-runner.startRun()       spawn k6, update status=running
               │
               │  on exit
               ▼
         update status → finished | failed | stopped
         write runs/{id}/summary.json   (via k6 handleSummary)
         write runs/{id}/stdout.txt     (via k6 handleSummary)

GET /runs/:id/status    → { id, status, startedAt, finishedAt }
GET /runs/:id/summary   → parsed summary.json
GET /runs/:id/stdout    → raw text
POST /runs/:id/stop     → SIGINT → status=stopping → stopped
```

## Status lifecycle

```
created → running → finished
                  → failed
                  → stopping → stopped
```