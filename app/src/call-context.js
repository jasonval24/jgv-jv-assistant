import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * PSTN tool calls run inside a call context so CallSid / callSessionId / From
 * are applied even if the model omits or invents them.
 */
export function runWithCallContext(context, fn) {
  return storage.run(context, fn);
}

export function getCallContext() {
  return storage.getStore() || null;
}
