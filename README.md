Try AI directly in your favorite apps … Use Gemini to generate drafts and refine content, plus get Gemini Pro with access to Google's next-gen AI
# curl-load

A developer tool that takes an HTTP request, converts it into a k6 load test, runs it, and exposes an API + UI to manage runs.

---

## Project structure

```
curl-load/
├── runner/     Node.js API — spawns k6, stores run state
├── web/        Dashboard UI (served by the runner)
├── public/     Workbench UI + documentation
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

| URL | Description |
|-----|-------------|
| `http://localhost:3000` | Dashboard — manage and compare past runs |
| `http://localhost:3000/load-tester.html` | Workbench — full-featured test builder |
| `http://localhost:3000/documentation.html` | Documentation |

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

## UI features

### Workbench (`load-tester.html`)

- Paste any curl command to generate a load test
- Configure virtual users, duration, ramp-up, and pause between requests
- Dynamic variables — built-in (`${random}`, `${user}`, `${iteration}`, `${timestamp}`, `${isoTimestamp}`) and user-defined (constant, sequential, random)
- Custom headers and auth (Bearer, Basic)
- Response validation (JSON path, XPath, text)
- Live latency chart during test execution
- Run Single for quick one-shot testing
- Run Remote to target any runner instance
- Save, load, clone, import, and export named projects
- Compare multiple runs side-by-side

### Dashboard (`/`)

- View and manage all past runs
- Click any run to load its config back into the form
- Live metrics while a run is in progress
- Download PDF report per run
- Copy report output to clipboard
- Delete runs

---

## Variables

Variables allow dynamic values in requests. Use `${variableName}` syntax anywhere in the URL, headers, or body.

### Built-in variables

| Variable | Description |
|----------|-------------|
| `${random}` | Random number (0–999999) |
| `${user}` | Virtual user ID |
| `${iteration}` | Request number per user |
| `${timestamp}` | Current Unix timestamp |
| `${isoTimestamp}` | ISO formatted timestamp |

### User-defined variables

| Type | Behaviour |
|------|-----------|
| Constant | Same value every request |
| Sequential | Next value per request, loops back |
| Random | Random value each request |

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| POST | `/runs` | Start a load test |
| GET | `/runs` | List recent runs |
| GET | `/runs/:id` | Get run metadata |
| GET | `/runs/:id/status` | Poll run status |
| GET | `/runs/:id/summary` | Get k6 summary (JSON) |
| GET | `/runs/:id/stdout` | Get raw k6 output |
| GET | `/runs/:id/metrics` | Get live metrics |
| GET | `/runs/:id/dashboard` | View k6 HTML dashboard |
| GET | `/runs/:id/report.pdf` | Download PDF report |
| POST | `/runs/:id/stop` | Stop a running test |
| DELETE | `/runs/:id` | Delete a finished run |

### POST /runs — request body

```json
{
  "url":       "https://example.com/api",
  "method":    "POST",
  "headers":   { "Authorization": "Bearer token" },
  "body":      { "key": "value" },
  "users":     10,
  "duration":  "30s",
  "pause":     1,
  "variables": {
    "productId": { "type": "sequential", "values": ["101", "102", "103"] }
  }
}
```

### Status lifecycle

```
created → running → finished
                  → failed
                  → stopping → stopped
```

---

## Docker (runner)

```bash
cd runner
docker build -t curl-load-runner .
docker run -p 3000:3000 curl-load-runner
```

---

## How it works

1. `POST /runs` creates a run record and generates a k6 script at `runner/runs/{id}/script.js`
2. The runner spawns `k6 run script.js` via `child_process.spawn`
3. Variables in the URL/body are resolved at runtime by k6's `resolveTemplate()` — built-ins and user-defined values alike
4. The k6 `handleSummary()` hook writes `summary.json` and `stdout.txt` into the run directory
5. The API serves those files on the status/summary/stdout endpoints
6. `POST /runs/:id/stop` sends `SIGINT` — k6 still flushes its summary before exiting