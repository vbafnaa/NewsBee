import { AsyncLocalStorage } from "node:async_hooks";

/** Structured JSON-line logging; Vercel and local terminals both show one event per line. */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogRecord = { level: LogLevel; component: string; event: string; time: string } & LogFields;
export type LogSink = (record: LogRecord) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function defaultSink(record: LogRecord) {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
}

let sink: LogSink = defaultSink;
const scopedSink = new AsyncLocalStorage<LogSink>();

export function setLogSink(next: LogSink | null) {
  sink = next ?? defaultSink;
}

export function withLogSink<T>(next: LogSink, operation: () => T): T {
  return scopedSink.run(next, operation);
}

function threshold(): number {
  const level = (process.env.NEWSBEE_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return ORDER[level] ?? ORDER.info;
}

function errorFields(fields: LogFields): LogFields {
  const error = fields.error;
  if (error instanceof Error) {
    return { ...fields, error: `${error.name}: ${error.message}` };
  }
  return fields;
}

export type Logger = {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

export function logger(component: string, base: LogFields = {}): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const record = { level, component, event, time: new Date().toISOString(), ...base, ...errorFields(fields) };
    scopedSink.getStore()?.(record);
    if (ORDER[level] >= threshold()) sink(record);
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (fields) => logger(component, { ...base, ...fields }),
  };
}
