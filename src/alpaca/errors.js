export class AlpacaApiError extends Error {
  constructor({ message, status, method, path, base, url, body }) {
    super(message);
    this.name = 'AlpacaApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.base = base;
    this.url = url;
    this.body = body;
  }

  isNotFound() {
    return this.status === 404;
  }

  detailLines() {
    const lines = [
      `  HTTP ${this.status} ${this.method} ${this.path}`,
      `  URL: ${this.url}`,
    ];
    if (this.body != null) {
      const bodyStr =
        typeof this.body === 'string'
          ? this.body
          : JSON.stringify(this.body, null, 2);
      lines.push(`  Response: ${bodyStr}`);
    }
    return lines;
  }
}

export function formatErrorReport(err, context) {
  const lines = [];
  if (context) lines.push(`Context: ${context}`);
  lines.push(`${err.name || 'Error'}: ${err.message}`);
  if (err instanceof AlpacaApiError) {
    lines.push(...err.detailLines());
  } else if (err.cause instanceof AlpacaApiError) {
    lines.push('Caused by:');
    lines.push(...err.cause.detailLines());
  }
  if (err.stack) {
    lines.push('Stack:');
    lines.push(err.stack.split('\n').slice(1, 6).join('\n'));
  }
  return lines.join('\n');
}

export function wrapError(err, context) {
  if (err instanceof AlpacaApiError) {
    const wrapped = new AlpacaApiError({
      message: `${context}: ${err.message}`,
      status: err.status,
      method: err.method,
      path: err.path,
      base: err.base,
      url: err.url,
      body: err.body,
    });
    wrapped.stack = err.stack;
    return wrapped;
  }
  const wrapped = new Error(`${context}: ${err.message}`);
  wrapped.cause = err;
  return wrapped;
}
