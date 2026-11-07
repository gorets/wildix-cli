// Errors that map to exit codes: UsageError 64 (EX_USAGE), AuthError 2, anything else 1.

export class UsageError extends Error {
  constructor(message, usage) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

const NOT_IMPLEMENTED = /is not implemented/;

export class HttpError extends Error {
  constructor(status, method, path, body, service = 'the service') {
    const lines = [`HTTP ${status} from ${service} (${method} ${path})`];
    if (body) lines.push(body.length > 2000 ? `${body.slice(0, 2000)}…` : body);
    if (status === 401) lines.push('The token was rejected: log in again.');
    if (NOT_IMPLEMENTED.test(body ?? ''))
      lines.push('The service does not implement this operation yet. Do not retry.');
    super(lines.join('\n'));
    this.name = 'HttpError';
    this.status = status;
  }
}
