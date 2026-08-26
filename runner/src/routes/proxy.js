import { Router } from 'express';

export const proxyRouter = Router();

proxyRouter.post('/', async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const bodyStr = body == null ? undefined
    : typeof body === 'string' ? body
    : JSON.stringify(body);

  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : bodyStr,
    });

    const elapsed = Date.now() - start;
    const responseHeaders = {};
    response.headers.forEach((val, key) => { responseHeaders[key] = val; });
    const responseBody = await response.text();

    res.json({ status: response.status, statusText: response.statusText, headers: responseHeaders, body: responseBody, elapsed });
  } catch (err) {
    res.status(502).json({ error: err.message, elapsed: Date.now() - start });
  }
});