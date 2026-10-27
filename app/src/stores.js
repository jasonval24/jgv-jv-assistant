import path from 'path';
import { config } from './config.js';
import { MEMORY_DEFAULTS } from './memory.js';
import { JOB_DEFAULTS } from './phone/jobs.js';
import { REMINDER_DEFAULTS } from './reminders.js';
import { createJsonStore } from './store.js';

export function dataFile(name) {
  return path.join(config.dataDir, name);
}

export const memoryStore = createJsonStore({
  filePath: dataFile('memory.json'),
  defaults: MEMORY_DEFAULTS,
});

export const reminderStore = createJsonStore({
  filePath: dataFile('reminders.json'),
  defaults: REMINDER_DEFAULTS,
});

export const jobStore = createJsonStore({
  filePath: dataFile('jobs.json'),
  defaults: JOB_DEFAULTS,
});
