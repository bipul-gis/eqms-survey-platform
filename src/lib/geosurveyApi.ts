export function getApiBase(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const base = env?.VITE_API_BASE_URL as string | undefined;
  if (base) return base.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    const cap = (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
        location?: { origin?: string; href?: string };
      }
    ).Capacitor;
    if (cap?.isNativePlatform?.()) {
      return 'https://geosurvey.eqmscl.com';
    }
    const origin = window.location?.origin;
    if (origin && !origin.startsWith('file://')) {
      return origin;
    }
    // Browser builds served from the same host use relative /api paths.
    return '';
  }
  return 'http://127.0.0.1:3002';
}

const SESSION_STORAGE_KEY = 'geosurvey_session_token';

function sessionStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  // Prefer localStorage so Capacitor apps keep the session across process kills.
  try {
    return window.localStorage;
  } catch {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  }
}

export function getStoredSessionToken(): string | null {
  const store = sessionStore();
  if (!store) return null;
  const fromPrimary = store.getItem(SESSION_STORAGE_KEY);
  if (fromPrimary) return fromPrimary;
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredSessionToken(token: string | null): void {
  const store = sessionStore();
  if (!store) return;
  if (token) {
    store.setItem(SESSION_STORAGE_KEY, token);
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, token);
    } catch {
      /* ignore */
    }
  } else {
    store.removeItem(SESSION_STORAGE_KEY);
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredSessionToken();
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: string }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const geosurveyApi = {
  health: () => apiFetch<{ ok: boolean }>('/api/health'),

  login: (email: string, password: string) =>
    apiFetch<{ profile: import('../types').UserProfile; sessionToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (body: {
    email: string;
    password: string;
    displayName: string;
    mobileNumber?: string;
  }) =>
    apiFetch<{ profile: import('../types').UserProfile; sessionToken: string }>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify(body) }
    ),

  forgotPassword: (email: string, mobileNumber: string) =>
    apiFetch<{ ok: boolean; message: string; temporaryPassword?: string }>(
      '/api/auth/forgot-password',
      { method: 'POST', body: JSON.stringify({ email, mobileNumber }) }
    ),

  session: () =>
    apiFetch<{ profile: import('../types').UserProfile; sessionToken: string }>('/api/auth/session'),

  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  listMisProjects: () =>
    apiFetch<{ items: import('../types').Project[] }>('/api/mis-projects'),

  listGeosurveyProjects: () =>
    apiFetch<{ items: import('../types').Project[] }>('/api/geosurvey-projects'),

  activateGeosurveyProject: (project: import('../types').Project) =>
    apiFetch<{ item: import('../types').Project }>(`/api/geosurvey-projects/${project.id}/activate`, {
      method: 'POST',
      body: JSON.stringify(project),
    }),

  deactivateGeosurveyProject: (projectId: string) =>
    apiFetch<{ ok: boolean }>(`/api/geosurvey-projects/${projectId}/deactivate`, {
      method: 'POST',
    }),

  updateGeosurveyProjectSegments: (
    projectId: string,
    segments: {
      geospatial?: boolean;
      questionnaire?: boolean;
      questionnaireGeofence?: boolean;
    }
  ) =>
    apiFetch<{ item: import('../types').Project }>(
      `/api/geosurvey-projects/${projectId}/segments`,
      {
        method: 'PATCH',
        body: JSON.stringify(segments),
      }
    ),

  listUsers: () =>
    apiFetch<{ items: import('../types').UserProfile[] }>('/api/users'),

  updateUser: (id: string, patch: Partial<import('../types').UserProfile>) =>
    apiFetch<{ profile: import('../types').UserProfile }>(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  createEnumerator: (body: {
    email: string;
    password: string;
    displayName: string;
    mobileNumber?: string;
  }) =>
    apiFetch<{ profile: import('../types').UserProfile }>('/api/users/enumerator', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteUser: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/users/${id}`, { method: 'DELETE' }),

  questionnaireCounts: () => apiFetch<Record<string, number>>('/api/questionnaires/counts'),

  listQuestionnaires: async (projectId?: string) => {
    const {
      cacheQuestionnaires,
      getCachedQuestionnaires,
      isNetworkFailure
    } = await import('./offlineResponses');
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    try {
      const result = await apiFetch<{ items: Record<string, unknown>[] }>(
        `/api/questionnaires${q}`
      );
      cacheQuestionnaires(result.items || []);
      return result;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      const cached = getCachedQuestionnaires();
      if (cached.length > 0) {
        const items = projectId
          ? cached.filter((item) => item.projectId === projectId)
          : cached;
        return { items };
      }
      throw error;
    }
  },

  saveQuestionnaire: (payload: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>(
      payload.id ? `/api/questionnaires/${payload.id}` : '/api/questionnaires',
      {
        method: payload.id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }
    ),

  deleteQuestionnaire: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/questionnaires/${id}`, { method: 'DELETE' }),

  listResponses: async (params?: {
    questionnaireId?: string;
    respondentId?: string;
    status?: string;
    projectId?: string;
    /** Strip embedded photo dataUrls for fast admin list screens. */
    slim?: boolean;
  }) => {
    const {
      cacheResponses,
      getCachedResponses,
      isNetworkFailure,
      mergeResponsesWithOffline
    } = await import('./offlineResponses');
    const search = new URLSearchParams();
    if (params?.questionnaireId) search.set('questionnaireId', params.questionnaireId);
    if (params?.respondentId) search.set('respondentId', params.respondentId);
    if (params?.status) search.set('status', params.status);
    if (params?.projectId) search.set('projectId', params.projectId);
    if (params?.slim) search.set('slim', '1');
    const q = search.toString() ? `?${search}` : '';
    try {
      const result = await apiFetch<{ items: Record<string, unknown>[] }>(
        `/api/responses${q}`
      );
      // Never cache slim (photo-stripped) payloads — that would wipe local photos.
      if (!params?.slim) {
        if (!params?.status && params?.respondentId) {
          cacheResponses(result.items || []);
        } else if (
          !params?.status &&
          !params?.questionnaireId &&
          !params?.respondentId &&
          !params?.projectId
        ) {
          cacheResponses(result.items || []);
        } else {
          const byId = new Map<string, Record<string, unknown>>();
          for (const item of getCachedResponses()) {
            if (typeof item.id === 'string') byId.set(item.id, item);
          }
          for (const item of result.items || []) {
            if (typeof item.id === 'string') byId.set(item.id, item);
          }
          cacheResponses(Array.from(byId.values()));
        }
      }
      return {
        items: params?.slim
          ? result.items || []
          : mergeResponsesWithOffline(result.items || [], params),
      };
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      return { items: mergeResponsesWithOffline(getCachedResponses(), params) };
    }
  },

  /** Full payloads for a page of response ids (CSV/SHP export). */
  getResponsesBatch: (ids: string[]) =>
    apiFetch<{ items: Record<string, unknown>[] }>('/api/responses/export-batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  getResponse: (id: string, opts?: { slim?: boolean }) => {
    const search = new URLSearchParams();
    if (opts?.slim) search.set('slim', '1');
    const q = search.toString() ? `?${search}` : '';
    return apiFetch<{ item: Record<string, unknown> }>(`/api/responses/${id}${q}`);
  },

  /** Slim GPS pins for map layer (no full answer payloads). */
  listResponseLocations: (params?: { projectId?: string; respondentId?: string }) => {
    const search = new URLSearchParams();
    if (params?.projectId) search.set('projectId', params.projectId);
    if (params?.respondentId) search.set('respondentId', params.respondentId);
    const q = search.toString() ? `?${search}` : '';
    return apiFetch<{
      items: Array<{
        id: string;
        questionnaireId: string;
        status: string;
        respondentName?: string;
        respondentEmail?: string;
        submittedAt?: unknown;
        lat: number;
        lng: number;
        accuracy?: number;
        capturedAt?: unknown;
        ward?: string;
      }>;
    }>(`/api/responses/locations${q}`);
  },

  saveResponse: async (
    payload: Record<string, unknown>,
    options?: { skipOfflineQueue?: boolean }
  ) => {
    const {
      enqueueOfflineResponse,
      persistQueuedResponse,
      isNetworkFailure,
      cacheResponses,
      getCachedResponses
    } = await import('./offlineResponses');

    const isTemporaryLocalId = (value: string): boolean =>
      /^offline_/.test(value) || /^resp_/.test(value);

    const persistOnline = () => {
      const id = typeof payload.id === 'string' ? payload.id.trim() : '';
      const usePostAsNew = !id || isTemporaryLocalId(id);
      const requestPayload = { ...payload } as Record<string, unknown>;
      if (usePostAsNew) {
        delete requestPayload.id;
      }
      return apiFetch<Record<string, unknown>>(
        usePostAsNew ? '/api/responses' : `/api/responses/${id}`,
        {
          method: usePostAsNew ? 'POST' : 'PUT',
          body: JSON.stringify(requestPayload)
        }
      );
    };

    const queueLocally = async () => {
      const queued = enqueueOfflineResponse(payload);
      try {
        await persistQueuedResponse(queued);
      } catch (e) {
        console.warn('geosurveyApi: failed to persist queued response payload', e);
      }
      return queued as Record<string, unknown>;
    };

    if (options?.skipOfflineQueue) {
      return persistOnline();
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return queueLocally();
    }

    try {
      const saved = await persistOnline();
      const id = typeof saved.id === 'string' ? saved.id : String(payload.id || '');
      if (id) {
        const byId = new Map<string, Record<string, unknown>>();
        for (const item of getCachedResponses()) {
          if (typeof item.id === 'string') byId.set(item.id, item);
        }
        byId.set(id, { ...payload, ...saved, id });
        cacheResponses(Array.from(byId.values()));
      }
      return saved;
    } catch (error) {
      if (isNetworkFailure(error)) return queueLocally();
      throw error;
    }
  },

  deleteResponse: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/responses/${id}`, { method: 'DELETE' }),

  listFeatures: () => apiFetch<{ items: Record<string, unknown>[] }>('/api/features'),

  saveFeature: (payload: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>(
      payload.id ? `/api/features/${payload.id}` : '/api/features',
      {
        method: payload.id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }
    ),

  bulkSaveFeatures: (items: Record<string, unknown>[]) =>
    apiFetch<{ count: number }>('/api/features/bulk', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  deleteFeature: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/features/${id}`, { method: 'DELETE' }),

  bulkDeleteFeatures: (ids: string[]) =>
    apiFetch<{ count: number }>('/api/features/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
};
