/** Remove a secret from text before it is shown or logged. */
export function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.replaceAll(secret, '[redacted]') : s;
}
