import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';
import type { LogLevel } from './config.js';

export type Logger = PinoLogger;

const interactiveTerminal = (): boolean =>
  process.env.NODE_ENV !== 'production' && process.env.VITEST === undefined && process.stdout.isTTY === true;

export function createLogger(level: LogLevel, pretty: boolean = interactiveTerminal()): Logger {
  const options: LoggerOptions = {
    level,
    base: { app: 'claude-code-monitor' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (!pretty || level === 'silent') return pino(options);
  return pino({
    ...options,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' },
    },
  });
}
