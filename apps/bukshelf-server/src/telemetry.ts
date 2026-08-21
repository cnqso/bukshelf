import { createHash } from 'node:crypto';

export type LogLevel = 'info' | 'warn' | 'error';

// Structured provider logs must never carry prompt text or secrets: only
// sizes, hashes, timings, identifiers, model names, and status codes.
export const logProviderEvent = (
  level: LogLevel,
  service: string,
  event: string,
  fields: Record<string, unknown> = {},
): void => {
  console[level](JSON.stringify({ service, event, ...fields }));
};

export const newRequestId = (): string => crypto.randomUUID();

export const fingerprint = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

export const errorCategory = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout_or_cancelled';
    return 'upstream_error';
  }
  return 'unknown_error';
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
