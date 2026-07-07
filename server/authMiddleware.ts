import type { Request, Response, NextFunction } from 'express';
import type { DbUser } from './userStore';
import { extractSessionToken, resolveSessionByToken } from './auth';
import { userToProfile } from './userStore';

export interface GeosurveyAuthenticatedRequest extends Request {
  geosurveySession?: {
    user: DbUser;
    profile: ReturnType<typeof userToProfile>;
    sessionToken: string;
  };
}

export async function requireAuth(
  req: GeosurveyAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractSessionToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const session = await resolveSessionByToken(token);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid.' });
    return;
  }
  req.geosurveySession = session;
  next();
}

export function requireAdmin(
  req: GeosurveyAuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.geosurveySession || req.geosurveySession.user.role !== 'admin') {
    res.status(403).json({ error: 'Administrator access required.' });
    return;
  }
  next();
}

export function requireApproved(
  req: GeosurveyAuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.geosurveySession || req.geosurveySession.user.status !== 'approved') {
    res.status(403).json({ error: 'Account not approved.' });
    return;
  }
  next();
}
