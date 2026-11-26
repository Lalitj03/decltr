/**
 * An error from an AI backend, with a short code the panel can act on
 * (for example "bad_key", "unreachable", "model_not_found") and a message fit to show a person.
 */
export class UpstreamError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
  }
}
