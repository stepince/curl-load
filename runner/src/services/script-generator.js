/**
 * Generates a valid k6 script from a request config.
 *
 * k6 scripts are plain JavaScript executed inside the k6 runtime,
 * so we build them as template strings — no extra dependencies needed.
 */

/**
 * @param {object} config
 * @param {string} config.url
 * @param {string} config.method       - GET | POST | PUT | PATCH | DELETE
 * @param {object} config.headers      - key/value map
 * @param {any}    config.body         - request body (serialised to JSON if object)
 * @param {number} config.users        - virtual users (vus)
 * @param {string} config.duration     - k6 duration string, e.g. "30s"
 * @param {string} runDir              - absolute path where summary.json / stdout.txt will be written
 * @returns {string} k6 script source code
 */
export function generateScript(config, runDir) {
  const { url, method, headers, body, variables, users, duration, pause } = config;

  // Serialise headers as a JS object literal inside the script
  const headersLiteral = JSON.stringify(headers || {}, null, 2);

  // Serialise body — k6's http module expects a string.
  // Keep ${...} placeholders intact so resolveTemplate can expand them at runtime.
  let bodyLiteral = 'null';
  if (body !== null && body !== undefined) {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    bodyLiteral = JSON.stringify(bodyString); // quoted JS string literal
  }

  // Variable definitions — embedded as a constant for runtime lookup
  const variablesLiteral = JSON.stringify(variables || {}, null, 2);

  // Escape the run directory for use inside the script string
  const escapedDir  = runDir.replace(/\\/g, '/');
  const escapedUrl  = url.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

  return `
import http from 'k6/http';
import { check, sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

export const options = {
  vus: ${users},
  duration: '${duration}',
  gracefulStop: '5s',
};

const HEADERS      = ${headersLiteral};
const URL_TEMPLATE = ${JSON.stringify(url)};
const BODY_TEMPLATE = ${bodyLiteral};
const VARIABLES    = ${variablesLiteral};

// Resolve \${...} placeholders at k6 runtime (per VU, per iteration).
function resolveTemplate(text) {
  return text.replace(/\\$\\{(\\w+)\\}/g, function(_, name) {
    if (name === 'random')       return String(Math.floor(Math.random() * 1000000));
    if (name === 'user')         return String(__VU);
    if (name === 'iteration')    return String(__ITER);
    if (name === 'timestamp')    return String(Date.now());
    if (name === 'isoTimestamp') return new Date().toISOString();
    var def = VARIABLES[name];
    if (!def || !def.values || !def.values.length) return '';
    if (def.type === 'sequential') return String(def.values[__ITER % def.values.length]);
    if (def.type === 'random')     return String(def.values[Math.floor(Math.random() * def.values.length)]);
    return String(def.values[0]); // constant
  });
}

export default function () {
  const url  = resolveTemplate(URL_TEMPLATE);
  const body = BODY_TEMPLATE !== null ? resolveTemplate(BODY_TEMPLATE) : null;

  const res = http.request('${method}', url, body, { headers: HEADERS });

  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  sleep(${pause != null ? pause : 1});
}

// handleSummary is called once after the test finishes.
// It writes machine-readable JSON and human-readable text to the run directory.
export function handleSummary(data) {
  return {
    '${escapedDir}/summary.json': JSON.stringify(data, null, 2),
    '${escapedDir}/stdout.txt':   textSummary(data, { indent: '  ', enableColors: false }),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}
`.trimStart();
}