const DEBUG = false;
const PREFIX = '[AI]';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function formatData(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'object') {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

function log(level: LogLevel, module: string, message: string, data?: unknown) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString().split('T')[1]?.slice(0, 12);
  const prefix = `${PREFIX}[${timestamp}][${module}]`;
  const formatted = data !== undefined ? `${message} ${formatData(data)}` : message;

  switch (level) {
    case 'info':
      console.log(`%c${prefix} ${formatted}`, 'color: #4fc3f7');
      break;
    case 'warn':
      console.warn(`${prefix} ${formatted}`);
      break;
    case 'error':
      console.error(`${prefix} ${formatted}`);
      break;
    case 'debug':
      console.log(`%c${prefix} ${formatted}`, 'color: #81c784');
      break;
  }
}

export const aiLogger = {
  store: {
    error: (operation: string, error: string) =>
      log('error', 'STORE', `${operation} failed: ${error}`),
  },
  chat: {
    send: (messageLength: number, contextCharacters: number) =>
      log('info', 'CHAT', `Sending message`, { messageLength, contextCharacters }),
    stream: (tokens: number) => log('debug', 'CHAT', `Streamed ${tokens} tokens`),
    complete: (responseLength: number) =>
      log('info', 'CHAT', `Response complete: ${responseLength} chars`),
    error: (error: string) => log('error', 'CHAT', error),
  },
  provider: {
    init: (provider: string, model: string) =>
      log('info', 'PROVIDER', `Initialized`, { provider, model }),
    chat: (provider: string, messageCount: number) =>
      log('debug', 'PROVIDER', `Chat request: ${messageCount} messages`, { provider }),
    error: (provider: string, error: string) =>
      log('error', 'PROVIDER', `${provider} error: ${error}`),
  },
};
