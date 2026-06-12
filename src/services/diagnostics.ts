interface LogEntry {
  timestamp: string;
  prefix: 'PLAYER DEBUG' | 'MPV DEBUG' | 'PLAYBACK SYNC DEBUG' | 'WATCH TOGETHER DEBUG' | 'PERF DEBUG';
  message: string;
}

const MAX_LOGS = 100;
let logs: LogEntry[] = [];
const listeners: Set<() => void> = new Set();

export function logEvent(
  prefix: LogEntry['prefix'],
  message: string
) {
  const timestamp = new Date().toISOString();
  const entry: LogEntry = { timestamp, prefix, message };
  
  // Also output to console
  console.log(`[${prefix}] ${message}`);

  logs.unshift(entry);
  if (logs.length > MAX_LOGS) {
    logs = logs.slice(0, MAX_LOGS);
  }
  
  listeners.forEach(l => l());
}

export function getLogs(): LogEntry[] {
  return logs;
}

export function clearLogs() {
  logs = [];
  listeners.forEach(l => l());
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
