# curl-load

A developer tool that takes an HTTP request, converts it into a k6 load test, runs it, and exposes an API + UI to manage runs.

---

## Project structure

```
curl-load/
├── runner/     Node.js API — spawns k6, stores run state
├── web/        Minimal HTML/JS UI
├── plugin/     CLI tool (npx curl-load)
└── docs/       Architecture notes
```

---

## Quick start (local)

### Prerequisites

- Node.js 18+
- [k6](https://k6.io/docs/get-started/installation/) installed and on `$PATH`

### 1 — Start the runner

```bash
cd runner
npm install
npm start
# Listening on http://localhost:3000
```

The runner also serves the web UI at `http://localhost:3000`.

### 2 — Open the UI

Navigate to `http://localhost:3000` in your browser.

### 3 — Use the CLI

```bash
cd plugin
npm install

# Basic GET
node src/cli.js run --url http://localhost:3000/health --users 5 --duration 10s

# POST with headers and body
node src/cli.js run \
  --url http://localhost:3000/runs \
  --method POST \
  --header "Content-Type: application/json" \
  --body '{"url":"http://example.com","users":2,"duration":"5s"}' \
  --users 1 --duration 5s

# Point at a different runner
node src/cli.js run --url http://example.com --runner http://my-runner:3000
```

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| POST | `/runs` | Start a load test |
| GET | `/runs/:id/status` | Poll run status |
| GET | `/runs/:id/summary` | Get k6 summary (JSON) |
| GET | `/runs/:id/stdout` | Get raw k6 output |
| POST | `/runs/:id/stop` | Stop a running test |

### POST /runs — request body

```json
{
  "url":      "https://example.com/api",
  "method":   "POST",
  "headers":  { "Authorization": "Bearer token" },
  "body":     { "key": "value" },
  "users":    10,
  "duration": "30s"
}
```

### Status values

`created` → `running` → `finished` | `failed` | `stopping` → `stopped`

---

## Docker (runner)

```bash
cd runner
docker build -t curl-load-runner .
docker run -p 3000:3000 curl-load-runner
```

---

## How it works

1. `POST /runs` creates a run record and writes a k6 script to `runner/runs/{id}/script.js`
2. The runner spawns `k6 run script.js` via `child_process.spawn`
3. The k6 `handleSummary()` hook writes `summary.json` and `stdout.txt` into the same directory
4. The API serves those files on the status/summary/stdout endpoints
5. `POST /runs/:id/stop` sends `SIGINT` — k6 will still flush its summary before exiting