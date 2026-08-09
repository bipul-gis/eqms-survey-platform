import test, { afterEach } from 'node:test';
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

function createIndexedDbMock() {
  const store = new Map<string, unknown>();

  const makeRequest = <T,>(result: T) => {
    const request: {
      result: T;
      error: Error | null;
      onsuccess: null | (() => void);
      onerror: null | (() => void);
    } = {
      result,
      error: null,
      onsuccess: null,
      onerror: null
    };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };

  const db = {
    objectStoreNames: {
      contains: (name: string) => name === 'pending_responses'
    },
    createObjectStore: () => undefined,
    close: () => undefined,
    transaction: () => {
      const tx = {
        error: null as Error | null,
        oncomplete: null as null | (() => void),
        onerror: null as null | (() => void),
        onabort: null as null | (() => void),
        objectStore: () => ({
          getAll: () => makeRequest(Array.from(store.values())),
          put: (value: { id: string }) => {
            store.set(value.id, structuredClone(value));
            queueMicrotask(() => tx.oncomplete?.());
            return makeRequest(undefined);
          },
          delete: (id: string) => {
            store.delete(id);
            queueMicrotask(() => tx.oncomplete?.());
            return makeRequest(undefined);
          }
        })
      };
      return tx;
    }
  } as const;

  return {
    open: () => {
      const request: {
        result: typeof db;
        error: Error | null;
        onsuccess: null | (() => void);
        onerror: null | (() => void);
        onupgradeneeded: null | (() => void);
      } = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

function makeQuotaGuardedStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (key: string, value: string) => {
    if (value.includes('data:image') || value.length > 5000) {
      throw new Error('Quota exceeded');
    }
    originalSetItem(key, value);
  };
  return storage;
}

afterEach(async () => {
  const { resetOfflineResponsesForTests } = await import('../src/lib/offlineResponses');
  resetOfflineResponsesForTests();
});

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
    const { resetOfflineResponsesForTests } = await import('../src/lib/offlineResponses');
    resetOfflineResponsesForTests();
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

test('replaces temporary offline ids with server ids when queued uploads succeed', async () => {
  const store = new MemoryStorage();
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;
  let requestMethod: string | undefined;
  let requestUrl: string | undefined;

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
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      requestMethod = (init?.method || 'GET').toUpperCase();
      requestUrl = String(input);
      return new Response(JSON.stringify({ id: 'server-generated-id', questionnaireId: 'q1', status: 'submitted' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  try {
    const {
      enqueueOfflineResponse,
      flushOfflineResponseQueue,
      getCachedResponses
    } = await import('../src/lib/offlineResponses');

    enqueueOfflineResponse({ id: 'offline_msgzjuga_13s17c', questionnaireId: 'q1', status: 'submitted' });
    await flushOfflineResponseQueue();

    assert.equal(requestMethod, 'POST');
    assert.equal(requestUrl, '/api/responses');

    const cached = getCachedResponses();
    const saved = cached.find((item) => String(item.id) === 'server-generated-id');
    assert.ok(saved);
    assert.equal(saved?.id, 'server-generated-id');
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

test('queues and flushes photo-bearing responses without writing the image inline to localStorage', async () => {
  const store = makeQuotaGuardedStorage();
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;
  const originalIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;
  let flushedBody = '';

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: store,
      indexedDB: createIndexedDbMock(),
      dispatchEvent: () => true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    }
  });
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: createIndexedDbMock()
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      flushedBody = String(init?.body || '');
      return new Response(JSON.stringify({ id: 'server-photo-response', questionnaireId: 'q-photo', status: 'submitted' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  const bigDataUrl = `data:image/jpeg;base64,${'a'.repeat(9000)}`;

  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: false }
    });
    const { geosurveyApi } = await import('../src/lib/geosurveyApi');
    const { flushOfflineResponseQueue, countPendingResponses, getPendingResponses } = await import('../src/lib/offlineResponses');

    const queued = await geosurveyApi.saveResponse({
      id: 'offline_msgzjuga_13s17c',
      questionnaireId: 'q-photo',
      status: 'submitted',
      responses: {
        photo_1: {
          dataUrl: bigDataUrl,
          mimeType: 'image/jpeg',
          capturedAt: '2026-08-09T00:00:00.000Z',
          source: 'camera',
          fileName: 'photo_camera.jpg'
        }
      }
    });

    assert.equal((queued as { status?: string }).status, 'queued');
    assert.equal(countPendingResponses(), 1);
    const pending = getPendingResponses()[0] as { responses?: Record<string, unknown> };
    assert.equal(typeof pending.responses?.photo_1, 'object');
    assert.equal(JSON.stringify(store.getItem('geosurvey_offline_pending_responses_manifest') || '').includes('data:image'), false);

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true }
    });

    const result = await flushOfflineResponseQueue();

    assert.equal(result.flushed, 1);
    assert.equal(result.failed, 0);
    assert.equal(countPendingResponses(), 0);
    assert.equal(flushedBody.includes(bigDataUrl), true);
  } finally {
    const { resetOfflineResponsesForTests } = await import('../src/lib/offlineResponses');
    resetOfflineResponsesForTests();
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      });
    }

    if (originalIndexedDb === undefined) {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    } else {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: originalIndexedDb
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
