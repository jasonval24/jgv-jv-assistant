import fs from 'fs';
import path from 'path';

/**
 * Atomic JSON file store. Survives process restarts if DATA_DIR is on a persistent disk.
 */
export function createJsonStore({ filePath, defaults = {} }) {
  const file = String(filePath);
  const dir = path.dirname(file);

  function read() {
    try {
      if (!fs.existsSync(file)) return structuredClone(defaults);
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : structuredClone(defaults);
    } catch {
      return structuredClone(defaults);
    }
  }

  function write(data) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return data;
  }

  function update(fn) {
    const current = read();
    const next = fn(current) ?? current;
    return write(next);
  }

  return { filePath: file, read, write, update };
}

export function createMemoryStore(seed = {}) {
  let data = structuredClone(seed);
  return {
    filePath: ':memory:',
    read: () => structuredClone(data),
    write: (next) => {
      data = structuredClone(next);
      return structuredClone(data);
    },
    update: (fn) => {
      const next = fn(structuredClone(data)) ?? data;
      data = structuredClone(next);
      return structuredClone(data);
    },
  };
}
