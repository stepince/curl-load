# curl-load

A developer tool that takes an HTTP request, converts it into a k6 load test, runs it, and exposes an API + UI to manage runs.

---

## Project structure

```
curl-load/
├── runner/     Node.js API — spawns k6, stores run state
├── web/        Dashboard UI (served by the runner)
├── public/     Workbench UI + documentation
└── docs/       Architecture notes
```

---

## Quick start (local)

### Prerequisites

- Node.js 18+
- [k6](https://k6.io/docs/get-started/installation/) installed and on `$PATH`
- [Go](https://go.dev/dl/) 1.21+ (only required to build the local k6 binary with the live dashboard extension)

### 1 — Build the local k6 binary (optional)

Provides a live web dashboard on port 5665 during test runs. Requires Go and installs xk6 automatically.

```bash
go install go.k6.io/xk6/cmd/xk6@latest
make k6
```

If you skip this step the runner falls back to the system `k6` on `$PATH`.

### 2 — Start the runner

```bash
cd runner
npm install
npm start
# Listening on http://localhost:3000
```

The runner also serves the web UI at `http://localhost:3000`.

### 3 — Open the UI

| URL | Description |
|-----|-------------|
| `http://localhost:3000` | Dashboard — manage and compare past runs |
| `http://localhost:3000/load-tester.html` | Workbench — full-featured test builder |
| `http://localhost:3000/documentation.html` | Documentation |

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

## Docker

```bash
docker run -p 3000:3000 -p 5665:5665 -v curl-load-runs:/app/runs curlload/curl-load-runner:latest
```

The `-v curl-load-runs:/app/runs` flag mounts a named volume so run history persists across image updates. The same volume is reattached when you pull and restart with a new image.

---

## CI/CD integration

Uses only `curl` and `jq` — no additional tooling required. Configure a test once in the UI, store the Run ID, then replay it on every deploy.

### Workflow

1. Run a test in the UI — copy the **Run ID** from the dashboard
2. Store it as a CI/CD environment variable (e.g. `BASELINE_RUN_ID`)
3. Use the script below in your pipeline

### Script

```bash
RUNNER=http://my-runner:3000

# 1. Fetch config from the baseline run, override VUs
CONFIG=$(curl -s $RUNNER/runs/$BASELINE_RUN_ID | jq '.config | .users = 50')

# 2. Start a new run
NEW_ID=$(curl -s -X POST $RUNNER/runs \
  -H "Content-Type: application/json" \
  -d "$CONFIG" | jq -r '.id')

echo "Run ID: $NEW_ID"

# 3. Poll until finished
while true; do
  STATUS=$(curl -s $RUNNER/runs/$NEW_ID/status | jq -r '.status')
  echo "Status: $STATUS"
  [ "$STATUS" = "finished" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "stopped" ] && break
  sleep 2
done

# 4. Print results
curl -s $RUNNER/runs/$NEW_ID/summary | jq '{
  totalRequests: .metrics.http_reqs.values.count,
  rps:           .metrics.http_reqs.values.rate,
  latencyAvg:    .metrics.http_req_duration.values.avg,
  latencyP95:    .metrics.http_req_duration.values["p(95)"],
  latencyP99:    .metrics.http_req_duration.values["p(99)"],
  errorRate:     .metrics.http_req_failed.values.rate
}'
```

### GitHub Actions example

```yaml
jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - name: Run load test
        id: load_test
        run: |
          RUNNER=${{ vars.RUNNER_URL }}

          CONFIG=$(curl -s $RUNNER/runs/${{ vars.BASELINE_RUN_ID }} | jq '.config | .users = 50')
          NEW_ID=$(curl -s -X POST $RUNNER/runs \
            -H "Content-Type: application/json" \
            -d "$CONFIG" | jq -r '.id')

          while true; do
            STATUS=$(curl -s $RUNNER/runs/$NEW_ID/status | jq -r '.status')
            [ "$STATUS" = "finished" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "stopped" ] && break
            sleep 2
          done

          SUMMARY=$(curl -s $RUNNER/runs/$NEW_ID/summary)
          echo "p95=$(echo $SUMMARY | jq '.metrics.http_req_duration.values["p(95)"]')" >> $GITHUB_OUTPUT
          echo "$SUMMARY" | jq '.metrics'

      - name: Show p95 latency
        run: echo "p95 latency = ${{ steps.load_test.outputs.p95 }} ms"
```

### Override execution parameters

```bash
# Smoke test
CONFIG=$(curl -s $RUNNER/runs/$BASELINE_RUN_ID | jq '.config | .users = 5 | .duration = "30s"')

# Load test
CONFIG=$(curl -s $RUNNER/runs/$BASELINE_RUN_ID | jq '.config | .users = 100 | .duration = "5m"')
```

---

## How it works

1. `POST /runs` creates a run record and generates a k6 script at `runner/runs/{id}/script.js`
2. The runner spawns `k6 run script.js` via `child_process.spawn`
3. Variables in the URL/body are resolved at runtime by k6's `resolveTemplate()` — built-ins and user-defined values alike
4. The k6 `handleSummary()` hook writes `summary.json` and `stdout.txt` into the run directory
5. The API serves those files on the status/summary/stdout endpoints
6. `POST /runs/:id/stop` sends `SIGINT` — k6 still flushes its summary before exiting