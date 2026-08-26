# curl-load Workbench Skill

You are controlling the **curl-load workbench** — a k6-based load testing tool with a REST API and a browser UI.

## App context

- **Workbench UI**: `http://localhost:3000/load-tester.html`
- **REST API base**: `http://localhost:3000`
- **Dashboard UI**: `http://localhost:3000/`

Prefer the REST API for automation. Use DOM interaction only when the API cannot accomplish the task.

---

## Profile management (localStorage)

Profiles are stored in `localStorage` under the key `loadTester.profiles` as a JSON object keyed by profile name:

```json
{
  "smoke-test": { "curlInput": "...", "users": 5, "duration": 30, ... }
}
```

The currently selected profile name is in `loadTester.lastProfile`.

### Form field IDs (UI)

| Field | Element ID |
|-------|-----------|
| Profile selector | `#scenarioSelect` |
| Profile name | `#projectName` |
| curl command | `#curlInput` |
| Peak virtual users | `#users` |
| Duration (s) | `#duration` |
| Total iterations | `#iterations` |
| Duration type | `#durationType` — `"time"` or `"iteration"` |
| Pause between requests | `#pause` |
| Ramp-up period | `#ramp` |
| Runner URL | `#remoteUrl` |
| Auth type | `#authType` — `"none"`, `"bearer"`, `"basic"` |
| Bearer token | `#authToken` |
| Basic username | `#authUsername` |
| Basic password | `#authPassword` |
| Response content type | `#responseContentType` — `"*"`, `"text"`, `"xml"`, `"json"` |
| Validation expression | `#validationExpression` |

### Variable rows

Variables are rows inside `#variables`. Each row has:
- Name input: `#varName_N` (N = 0-based index)
- Value input: `#varValue_N`
- Type select: `#varType_N` — `"constant"`, `"sequential"`, `"random"`, `"random-pick"`

Add a variable row via `addVariable()` (global function).

### Header rows

Headers are inside `#headersContainer`. Add via `addHeader()`.

### Profile actions (UI functions)

```js
addProfile()     // create new profile from current Name field
saveProfile()    // save current form state to selected profile
loadProfile()    // load selected profile into form
deleteProfile()  // delete selected profile
cloneProfile()   // clone selected profile
```

---

## Running a load test via REST API

### Start a run

```
POST /runs
Content-Type: application/json

{
  "url": "https://api.example.com/endpoint",
  "method": "GET",
  "headers": { "Authorization": "Bearer <token>" },
  "body": "",
  "users": 10,
  "duration": 60,
  "name": "smoke-test",
  "variables": [
    { "name": "userId", "type": "sequential", "value": "1,2,3,4,5" }
  ],
  "pause": 1,
  "timeout": 30
}
```

Returns: `{ "id": "<runId>", "status": "created" }`

### Poll status

```
GET /runs/<runId>/status
```

Returns: `{ "id": "...", "status": "running|finished|failed|stopped", "startedAt": "...", "finishedAt": "..." }`

Poll every 2–5 seconds until `status` is `finished`, `failed`, or `stopped`.

### Run a single request (one-shot, not a load test)

```
POST /proxy
Content-Type: application/json

{
  "url": "https://api.example.com/endpoint",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": "{\"key\":\"value\"}"
}
```

Returns the full HTTP response from the target.

---

## Reading results

### Final summary (after run finishes)

```
GET /runs/<runId>/summary
```

Key metric paths:
```
metrics.http_req_duration.values.avg      — average latency (ms)
metrics.http_req_duration.values["p(95)"] — p95 latency (ms)
metrics.http_req_duration.values["p(99)"] — p99 latency (ms)
metrics.http_req_duration.values.max      — max latency (ms)
metrics.http_reqs.values.count            — total requests
metrics.http_req_failed.values.rate       — error fraction (0–1)
```

### Live metrics (during run)

```
GET /runs/<runId>/metrics
```

Returns: `{ "requests": N, "avg": "12.34", "p95": "45.67", "p99": "67.89", "max": "100.00", "errorRate": "0.12", "timeseries": [...] }`

---

## Stopping a run

```
POST /runs/<runId>/stop
```

---

## Example workflows

### Create and save a profile

1. Set `#projectName` to `"smoke-test"`
2. Paste a curl command into `#curlInput`
3. Set `#users` to `5`, `#duration` to `30`
4. Call `addProfile()` then `saveProfile()`

### Run a load test and report back

1. `POST /runs` with the desired config
2. Poll `GET /runs/<id>/status` every 3 seconds until finished
3. `GET /runs/<id>/summary` and extract `http_req_duration.values.avg`, `p(95)`, `p(99)`, `http_req_failed.values.rate`
4. Report: avg latency, p95, p99, total requests, error rate

### Adjust users and re-run

1. Set `#users` to the new value
2. `POST /runs` with updated config
3. Poll and report