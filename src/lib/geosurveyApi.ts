export function getApiBase(): string {
  const base = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (base) return base.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    // Capacitor Android/iOS WebViews have no Vite proxy — call the live API.
    const cap = (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    if (cap?.isNativePlatform?.()) {
      return 'https://geosurvey.eqmscl.com';
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

  listQuestionnaires: (projectId?: string) => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return apiFetch<{ items: Record<string, unknown>[] }>(`/api/questionnaires${q}`);
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

  listResponses: (params?: { questionnaireId?: string; respondentId?: string; status?: string }) => {
    const search = new URLSearchParams();
    if (params?.questionnaireId) search.set('questionnaireId', params.questionnaireId);
    if (params?.respondentId) search.set('respondentId', params.respondentId);
    if (params?.status) search.set('status', params.status);
    const q = search.toString() ? `?${search}` : '';
    return apiFetch<{ items: Record<string, unknown>[] }>(`/api/responses${q}`);
  },

  saveResponse: (payload: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>(
      payload.id ? `/api/responses/${payload.id}` : '/api/responses',
      {
        method: payload.id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }
    ),

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
