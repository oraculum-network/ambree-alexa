// One JSON line per event. Callers pass only route, status, timings, mode and tool
// names: never user text, replies, IPs, cookies or keys.

export type LogValue = string | number | boolean | null | undefined | string[];
export type LogRecord = Record<string, LogValue>;
export type Logger = (record: LogRecord) => void;

export const jsonLogger: Logger = (record) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n");
};

export const silentLogger: Logger = () => {};
