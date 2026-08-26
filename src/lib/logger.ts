import { env } from '../config/index.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const threshold = LEVEL_ORDER[env.LOG_LEVEL];

function emit(level: Level, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (meta === undefined) {
    sink(`${prefix} ${message}`);
  } else {
    sink(`${prefix} ${message}`, meta);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
};
