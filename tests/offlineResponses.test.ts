import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, value); }
}

test('keeps queued responses when flush hits a non-network server error', async () => {
  const store = new MemoryStorage();
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: store }
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      throw new Error('Internal server error');
    }
  });

  try {
    const { enqueueOfflineResponse, flushOfflineResponseQueue, countPendingResponses } = await import('../src/lib/offlineResponses');
    enqueueOfflineResponse({ id: 'queued-response', questionnaireId: 'q1', status: 'submitted' });
    assert.equal(countPendingResponses(), 1);

    const result = await flushOfflineResponseQueue();

    assert.equal(result.flushed, 0);
    assert.equal(result.failed, 1);
    assert.equal(countPendingResponses(), 1);
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      });
    }

    if (originalNavigator === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator
      });
    }

    if (originalFetch === undefined) {
      delete (globalThis as { fetch?: unknown }).fetch;
    } else {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch
      });
    }
  }
});

test('keeps queued responses when the server returns an HTTP error response', async () => {
  const store = new MemoryStorage();
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: store }
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify({ error: 'validation failed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  });

  try {
    const { enqueueOfflineResponse, flushOfflineResponseQueue, countPendingResponses } = await import('../src/lib/offlineResponses');
    enqueueOfflineResponse({ id: 'http-error-response', questionnaireId: 'q1', status: 'submitted' });
    assert.equal(countPendingResponses(), 1);

    const result = await flushOfflineResponseQueue();

    assert.equal(result.flushed, 0);
    assert.equal(result.failed, 1);
    assert.equal(countPendingResponses(), 1);
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      });
    }

    if (originalNavigator === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator
      });
    }

    if (originalFetch === undefined) {
      delete (globalThis as { fetch?: unknown }).fetch;
    } else {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch
      });
    }
  }
});

test('emits a queue-change event when a response is queued locally', async () => {
  const store = new MemoryStorage();
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;

  const eventTarget = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: store,
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget)
    }
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify({ id: 'queued-response', questionnaireId: 'q1', status: 'submitted' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });

  try {
    const { enqueueOfflineResponse } = await import('../src/lib/offlineResponses');
    let seenEvent = false;
    const handler = () => { seenEvent = true; };
    eventTarget.addEventListener('geosurvey:offline-queue-changed', handler);

    enqueueOfflineResponse({ id: 'queued-response', questionnaireId: 'q1', status: 'submitted' });

    assert.equal(seenEvent, true);
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      });
    }

    if (originalNavigator === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator
      });
    }

    if (originalFetch === undefined) {
      delete (globalThis as { fetch?: unknown }).fetch;
    } else {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch
      });
    }
  }
});

test('queues offline submissions locally until the upload succeeds', async () => {
  const store = new MemoryStorage();
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: store,
      dispatchEvent: () => true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () =>
      new Response(JSON.stringify({ id: 'queued-response', questionnaireId: 'q1', status: 'submitted' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  });

  try {
    const {
      enqueueOfflineResponse,
      flushOfflineResponseQueue,
      getPendingResponses,
      countPendingResponses
    } = await import('../src/lib/offlineResponses');

    const entry = enqueueOfflineResponse({ id: 'queued-response', questionnaireId: 'q1', status: 'submitted' });
    assert.equal(entry.status, 'queued');
    assert.equal(getPendingResponses()[0].status, 'queued');

    const result = await flushOfflineResponseQueue();

    assert.equal(result.flushed, 1);
    assert.equal(result.failed, 0);
    assert.equal(countPendingResponses(), 0);
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      });
    }

    if (originalNavigator === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator
      });
    }

    if (originalFetch === undefined) {
      delete (globalThis as { fetch?: unknown }).fetch;
    } else {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch
      });
    }
  }
});
