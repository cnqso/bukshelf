export type TTSDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TTSDiagnosticEvent {
  at: string;
  sequence: number;
  sessionId?: string;
  component: string;
  event: string;
  level: TTSDiagnosticLevel;
  details?: Record<string, string | number | boolean | null>;
}

const MAX_EVENTS = 500;
const STORAGE_KEY = 'bukshelf.tts.diagnostics';
const events: TTSDiagnosticEvent[] = [];
let sequence = 0;

const hydrate = () => {
  if (events.length > 0 || typeof sessionStorage === 'undefined') return;
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as TTSDiagnosticEvent[];
    events.push(...stored.slice(-MAX_EVENTS));
    sequence = events.at(-1)?.sequence ?? 0;
  } catch {
    // A corrupt diagnostics buffer should be discarded, never propagated.
  }
};

const persist = () => {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Diagnostics must never interfere with playback.
  }
};

export const recordTTSDiagnostic = (
  event: Omit<TTSDiagnosticEvent, 'at' | 'sequence'>,
): TTSDiagnosticEvent => {
  hydrate();
  const entry: TTSDiagnosticEvent = {
    at: new Date().toISOString(),
    sequence: ++sequence,
    ...event,
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  persist();
  // Next's development overlay treats console.error as an application crash.
  // Diagnostics have their own visible UI, so even terminal events use warn.
  const write = event.level === 'error' || event.level === 'warn' ? console.warn : console.info;
  write(`[bukshelf:tts] ${JSON.stringify(entry)}`);
  return entry;
};

export const getTTSDiagnostics = (): readonly TTSDiagnosticEvent[] => {
  hydrate();
  return [...events];
};

export const clearTTSDiagnostics = (): void => {
  events.length = 0;
  persist();
};

export const fingerprintTTSInput = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
