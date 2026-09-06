# curl-load Workbench Skill

You are controlling the **curl-load workbench** — a k6-based load testing tool with a REST API and a browser UI.

## App context

- **Workbench UI**: `http://localhost:3000/load-tester.html`
- **REST API base**: `http://localhost:3000`
- **Dashboard UI**: `http://localhost:3000/`

Prefer the REST API for automation. Use DOM interaction only when the API cannot accomplish the task.

Full interactive API docs (Swagger UI) are served at `http://localhost:3000/docs`; the raw OpenAPI 3.0 spec is at `http://localhost:3000/openapi.json`.

---

## Profile management (localStorage)

Profiles are stored in `localStorage` under the key `loadTester.profiles` as a JSON object keyed by profile name:

```json
{
  "smoke-test": { "curlInput": "...", "users": 5, "duration": 30, ... }
}
```

The currently selected profile name is in `loadTester.lastProfile`.

### Runner URL (global setting)

Unlike other fields, the runner URL is **not** per-profile — it's a single global setting shared across all projects, stored in `localStorage` under `loadTester.remoteUrl`. It's configured via the gear icon → Settings modal (`#settingsRunnerUrl` input, saved via `saveRunnerUrl()`), not on the main form. Read it with `localStorage.getItem('loadTester.remoteUrl')`; falls back to the page's own origin if unset.

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
- Type select: `#varType_N` — `"constant"`, `"sequential"`, `"random"`

Add a variable row via `addVariable()` (global function).

### Header rows

Headers are inside `#headersContainer`. Add via `addHeader()`.

### Auto Extract (Headers & Variables)

`autoExtractHeaders()` and `autoExtractVariables()` scan the current `#curlInput` text:
- **Headers**: any `-H` header in the curl command not already present in `#headersContainer` gets added as a row. An `Authorization: Bearer <token>` / `Basic <creds>` header is routed into the Auth fields (`#authType`, `#authToken` / `#authUsername`+`#authPassword`) instead of a plain header row.
- **Variables**: only recognizes `${name}` placeholders **already written** in the curl command (URL or body) — it does **not** turn literal values into variables automatically. To make a value variable-driven, replace the literal with `${name}` yourself first, then call `autoExtractVariables()` to create the (empty-valued) variable row for it.

Both functions `alert()` when there's nothing to extract — there's no silent/programmatic variant of the public `autoExtractHeaders()`/`autoExtractVariables()` functions, so driving them via automation may trigger a blocking dialog if the curl command has no headers/placeholders.

### Profile actions (UI functions)

```js
addProfile()     // reset the form to a blank project (also reachable via the "New" panel's "Basic" button)
saveProfile()    // save current form state to selected profile
loadProfile()    // load selected profile into form
cloneProfile()   // clone selected profile
```

> **Overwrite protection:** `saveProfile()` and `cloneProfile()` prompt with a native `confirm()` dialog if the target name collides with an existing profile that isn't the one currently loaded/selected. If driving this via script/automation, avoid reusing an existing profile name unless you intend to overwrite it — a collision will block on the dialog, which automation has no way to answer.

Deleting a profile is no longer a single-target function — see **Delete panel** below.

### Building a request from fields (Advanced form)

Instead of pasting a curl command, the "New" panel (opened via `#newProjectToggleBtn`, labeled "New") has an "Advanced — build from fields" mode that constructs one from separate inputs:

| Field | Element ID |
|-------|-----------|
| URL | `#newProjectUrl` |
| Method | `#newProjectMethod` — `GET`/`POST`/`PUT`/`PATCH`/`DELETE` |
| Request Content-Type | `#newProjectContentType` — `""` (none), `"application/json"`, `"application/xml"`, `"text/plain"`, `"application/x-www-form-urlencoded"` |
| Payload | `#newProjectPayload` (optional, any format — not JSON-validated) |

Calling `createProjectFromFields()` resets the form, builds a curl command via `buildCurlCommand(url, method, payload, contentType)`, writes it into `#curlInput`, then runs Auto Extract for headers and variables automatically (so a JSON `${...}`-templated payload and its Content-Type header get pulled into the Headers/Variables sections without an extra step). For REST-API-driven automation this is usually unnecessary — POST the equivalent `{url, method, headers, body}` directly to `/runs` instead; this path exists mainly for a human building a request without knowing curl syntax.

### Export, Import, and Delete panels

The profile-bar toolbar has three floating dropdown panels — Export, Import, and Delete — that share one review-table pattern: a checkbox per row, "Select All", and an action button. Opening any one of them (or the "New" panel, or the curl-command "Edit" panel) closes the others; clicking outside a panel closes it too.

**Export** (`#exportToggleBtn` → `toggleExportPanel()`): lists every saved profile by name as a checkbox. `exportSelectedProjects()` downloads the checked ones as a single JSON file (`{ version: 1, projects: { <name>: <profileData>, ... } }`) — this is curl-load's own export format.

**Import** (`#importToggleBtn` → `toggleImportPanel()`): a 2-step flow.
1. **Step 1** — pick a file via `#importFileInput` (`.json`, `.yaml`, `.yml`). `detectAndParseImportFile()` accepts two formats: curl-load's own export JSON (`{ projects: {...} }`), or an OpenAPI spec (v2 "swagger" or v3 "openapi", JSON or YAML — YAML parsed via the `jsyaml` global). An OpenAPI spec is converted via `convertOpenApiToProjects()`: one candidate project per operation, path params (`{id}`) become `${id}` curl-load variables (pre-registered in the project's Variables list), the method is always written explicitly (`-X GET`/`-X POST`/etc. — never omitted, even for GET), and a JSON request body is built from the schema's `example`/`default` values when present (`buildExampleBodyFromSchema()`), falling back to type-appropriate empty values.
2. **Step 2** — a review table (checkbox / editable name / method / url) for every candidate found, all checked by default. The **name is editable inline** — typing a new name updates that row's target project name live, including the "will overwrite existing" warning if it now collides with a saved profile. `applyImportSelection()` writes the checked rows into profiles (overwriting any name collision) with no further confirmation — the review table itself is the confirmation step, unlike Delete below.

**Delete** (`#deleteToggleBtn` → `toggleDeletePanel()`): same review-table shape (checkbox / name / method / url), but listing every saved profile rather than file candidates. `deleteSelectedProjects()` requires a native `confirm()` naming exactly which projects will be removed before applying — unlike Import, this is destructive with no undo. If driving this via automation, note the `confirm()` will block unless the environment can answer it.

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