let cachedToken: { token: string; expiresAt: number } | null = null;

interface MisProject {
  id: string;
  code: string;
  name: string;
  client?: string;
  department?: string;
  manager?: string;
  managerId?: string;
  country?: string;
  location?: string;
  status?: string;
}

function misApiBase(): string {
  return (process.env.MIS_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
}

async function getMisSessionToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const email = process.env.MIS_SERVICE_EMAIL;
  const password = process.env.MIS_SERVICE_PASSWORD;
  if (!email || !password) {
    throw new Error('MIS_SERVICE_EMAIL and MIS_SERVICE_PASSWORD must be set.');
  }
  const res = await fetch(`${misApiBase()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MIS login failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { sessionToken: string };
  cachedToken = { token: data.sessionToken, expiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000 };
  return data.sessionToken;
}

export async function fetchMisProjects(): Promise<MisProject[]> {
  const token = await getMisSessionToken();
  const all: MisProject[] = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const url = `${misApiBase()}/api/eqms-projects?limit=${limit}&offset=${offset}&lightweight=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MIS projects fetch failed (${res.status}): ${text}`);
    }
    const page = (await res.json()) as {
      items: MisProject[];
      hasMore: boolean;
      offset: number;
      limit: number;
    };
    all.push(...page.items);
    if (!page.hasMore) break;
    offset += page.limit;
  }
  return all;
}

export function misProjectToGeosurvey(p: MisProject) {
  const active = p.status === 'Ongoing' || p.status === 'Payment Pending';
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    description: [p.client, p.department, p.location || p.country].filter(Boolean).join(' — '),
    segments: { geospatial: true, questionnaire: true },
    isActive: active,
    misStatus: p.status,
    manager: p.manager,
    managerId: p.managerId,
  };
}
