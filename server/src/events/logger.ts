export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogRecord = {
  level: LogLevel;
  scope: string;
  message: string;
  at: string;
  data?: Record<string, unknown>;
};
export type LogSink = (record: LogRecord) => void;

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const sink: LogSink = (record) => {
  const line = `[${record.at}] ${record.level.toUpperCase()} ${record.scope}: ${record.message}`;
  const fn = order[record.level] >= 30 ? console.error : console.log;
  fn(record.data ? `${line} ${JSON.stringify(record.data)}` : line);
};

export class Logger {
  private readonly records: LogRecord[] = [];
  constructor(private readonly scope: string, private readonly output: LogSink = sink) {}
  child(scope: string) { return new Logger(`${this.scope}:${scope}`, this.output); }
  debug(message: string, data?: Record<string, unknown>) { this.write("debug", message, data); }
  info(message: string, data?: Record<string, unknown>) { this.write("info", message, data); }
  warn(message: string, data?: Record<string, unknown>) { this.write("warn", message, data); }
  error(message: string, data?: Record<string, unknown>) { this.write("error", message, data); }
  history() { return [...this.records]; }
  private write(level: LogLevel, message: string, data?: Record<string, unknown>) {
    const record = { level, scope: this.scope, message, at: new Date().toISOString(), data };
    this.records.push(record);
    if (this.records.length > 500) this.records.shift();
    const configured = (process.env.LOG_LEVEL ?? "info") as LogLevel;
    if (order[level] >= (order[configured] ?? order.info)) this.output(record);
  }
}

export const rootLogger = new Logger("ul");
