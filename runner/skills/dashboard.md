# curl-load Dashboard Skill

You are controlling the **curl-load dashboard** — the run history and comparison UI for a k6-based load testing tool.

## App context

- **Dashboard UI**: `http://localhost:3000/`
- **REST API base**: `http://localhost:3000`
- **Workbench UI**: `http://localhost:3000/load-tester.html`

Prefer the REST API for automation. Use DOM interaction only when the API cannot accomplish the task.

---

## Listing runs

```
GET /runs?limit=50
```

Returns an array of run objects (newest first):
```json
[
  {
    "id": "<uuid>",
    "config": {
      "name": "smoke-test",
      "url": "https://api.example.com",
      "users": 10,
      "duration": 60
    },
    "status": "finished",
    "startedAt": "2026-08-25T10:00:00.000Z",
    "finishedAt": "2026-08-25T10:01:05.000Z"
  }
]
```

Status values: `created`, `running`, `stopping`, `stopped`, `finished`, `failed`

---

## Reading a run's metrics

### Final summary (structured)

```
GET /runs/<runId>/summary
```

Key metric paths:
```
metrics.http_req_duration.values.avg      — average latency (ms)
metrics.http_req_duration.values["p(95)"] — p95 latency (ms)
metrics.http_req_duration.values["p(99)"] — p99 latency (ms)
metrics.http_req_duration.values.max      — max latency (ms)
metrics.http_reqs.values.count            — total requests sent
metrics.http_req_failed.values.rate       — error fraction (0.0–1.0); multiply by 100 for %
```

### Live metrics endpoint

```
GET /runs/<runId>/metrics
```

Returns: `{ "requests": N, "avg": "12.34", "p95": "45.67", "p99": "67.89", "max": "100.00", "errorRate": "0.12" }`

---

## Generating a comparison PDF report

To compare multiple runs, POST their IDs:

```
POST /runs/compare/report.pdf
Content-Type: application/json

{
  "ids": ["<runId1>", "<runId2>", "<runId3>"]
}
```

The response is a binary PDF (`application/pdf`). Save it as `curl-load-comparison.pdf`.

**Minimum 2 IDs required.**

### Via the dashboard UI

1. Check the checkboxes next to the runs you want to compare (`input.run-checkbox[data-id]`)
2. Call `downloadComparisonPdf()` (global function) — it POSTs and triggers a browser download

---

## Selecting runs by criteria

To select the last N finished runs:
1. `GET /runs?limit=50`
2. Filter: `runs.filter(r => r.status === 'finished')`
3. Take the first N: `.slice(0, N)`
4. Extract IDs: `.map(r => r.id)`

---

## Interpreting results

| Metric | What it means |
|--------|--------------|
| avg latency | Mean response time across all requests |
| p95 | 95th percentile — 95% of requests were faster than this |
| p99 | 99th percentile — 99% of requests were faster than this |
| max | Slowest single request |
| error rate | Fraction of requests that failed (HTTP errors or timeouts) |

A healthy API typically has p95 < 200ms and error rate < 1%.

---

## Deleting a run

```
DELETE /runs/<runId>
```

Only works for `finished`, `failed`, or `stopped` runs. Returns `{ "id": "...", "deleted": true }`.

---

## Example workflows

### Compare last 3 finished runs and summarize

1. `GET /runs?limit=20`
2. Filter to `status === "finished"`, take first 3, extract IDs
3. Fetch `GET /runs/<id>/summary` for each
4. Summarize:
   - Which run had the lowest avg latency?
   - Did p95 improve or degrade across runs?
   - Any runs with error rate > 1%?
5. `POST /runs/compare/report.pdf` with the 3 IDs to generate a downloadable comparison

### Find regressions between two runs

1. Fetch summary for run A and run B
2. Compare `http_req_duration.values["p(95)"]`
3. If B's p95 is more than 20% higher than A's, flag as a regression
4. Report: "p95 increased from Xms to Yms (+Z%)"

### Report on all runs for a named profile

1. `GET /runs?limit=100`
2. Filter: `runs.filter(r => r.config.name === "smoke-test")`
3. For each, fetch `/summary` and extract key metrics
4. Report a table: run date, avg, p95, p99, error rate
