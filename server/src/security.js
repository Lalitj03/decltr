// Request gatekeeping for a server that holds a secret and listens on localhost.
//
// Threats handled:
//  - A web page you visit calling http://127.0.0.1 (CSRF): browsers always send
//    an Origin header on cross-origin POSTs and pages cannot forge it. Only the
//    pinned extension origin is accepted.
//  - DNS rebinding: a hostile domain resolving to 127.0.0.1 sends its own Host
//    header, which will not match.
// Not handled: another process running as you can forge headers. That process
// could read the Keychain item itself, so there is nothing more to protect.

export function authorize(req, { port, allowedOrigins }) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 403, code: 'bad_host', message: 'Unexpected Host header.' };
  }
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    return { ok: false, status: 403, code: 'forbidden_origin', message: 'This origin is not allowed.' };
  }
  return { ok: true, origin };
}

export class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = [];
  }

  /** Returns true if the call is allowed and records it. */
  take() {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t);
    return true;
  }
}

export function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.replaceAll(secret, '[redacted]') : s;
}
