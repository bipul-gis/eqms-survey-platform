import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

admin.initializeApp();

/** Injected on every `npm run build` in `functions/` (see `scripts/inject-functions-env.cjs`). */
type RuntimeAppletConfig = { apiKey?: string; projectId?: string };

function loadRuntimeAppletConfig(): RuntimeAppletConfig | null {
  try {
    const p = join(__dirname, '..', 'applet-config.runtime.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as RuntimeAppletConfig;
  } catch (e) {
    logger.warn('applet-config.runtime.json missing or invalid; use .env or rebuild functions', e);
    return null;
  }
}

/** Cloud Functions often do not populate `process.env` from `functions/.env` at runtime; read bundled JSON too. */
/** Note: env vars must not use prefix `FIREBASE_` — Firebase deploy rejects them (reserved). */
function resolveWebApiKey(): string | undefined {
  const fromEnv = process.env.WEB_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return loadRuntimeAppletConfig()?.apiKey?.trim() || undefined;
}

function firestoreForUsers() {
  const dbId = process.env.FIRESTORE_DATABASE_ID?.trim();
  if (dbId) {
    return getFirestore(admin.app(), dbId);
  }
  return getFirestore(admin.app());
}

function normalizeEmail(e: unknown): string | null {
  const s = typeof e === 'string' ? e.trim().toLowerCase() : '';
  if (!s || !s.includes('@')) return null;
  return s;
}

/** Compare stored vs entered mobile: digits only; strips leading 880 / 88 for Bangladesh-style numbers. */
function normalizePhoneBd(input: unknown): string {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.startsWith('880') && d.length >= 12) d = d.slice(3);
  else if (d.startsWith('88') && d.length === 12) d = d.slice(2);
  return d;
}

/**
 * Same behavior as the client SDK `sendPasswordResetEmail` — often succeeds when
 * `generatePasswordResetLink` fails (e.g. email casing / project quirks).
 * Uses `WEB_API_KEY` from `functions/.env`, auto-written on deploy from
 * `firebase-applet-config.json` (see `scripts/inject-functions-env.cjs`).
 */
async function sendPasswordResetOob(email: string, apiKey: string): Promise<void> {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestType: 'PASSWORD_RESET',
      email
    })
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message: string; errors?: { message: string }[] };
  };
  if (!res.ok) {
    const msg = body.error?.message || `sendOobCode failed (${res.status})`;
    throw new Error(msg);
  }
}

function describeLinkGenerationFailure(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: string }).code) : '';
  switch (code) {
    case 'auth/configuration-not-found':
      return 'Firebase Auth email action configuration is missing. In Firebase Console open Authentication → Templates and save the password-reset template.';
    case 'auth/unauthorized-continue-uri':
      return 'Password reset redirect domain is not authorized. Add your app domain under Authentication → Settings → Authorized domains.';
    default:
      logger.error('generatePasswordResetLink failed', err);
      return 'Could not create a reset link. Redeploy functions (predeploy injects apiKey), or try again later.';
  }
}

/** Helps Admin SDK generate links when continue URLs must match authorized domains (uses default Hosting domain). */
async function generatePasswordResetLinkReliable(canonicalEmail: string): Promise<string> {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (projectId) {
    try {
      return await admin.auth().generatePasswordResetLink(canonicalEmail, {
        url: `https://${projectId}.firebaseapp.com`,
        handleCodeInApp: false
      });
    } catch (e) {
      logger.warn('generatePasswordResetLink with firebaseapp.com continueUrl failed, retrying minimal', e);
    }
  }
  return admin.auth().generatePasswordResetLink(canonicalEmail);
}

/**
 * Enumerator-only password reset: confirms Firebase Auth email exists, then checks Firestore `users/{uid}`
 * has the same `uid`, enumerator role, and matching `mobileNumber` as registered.
 * Prefers sending the standard Firebase reset **email** (Identity Toolkit) when the Web API key is available;
 * otherwise returns a one-time reset link from the Admin SDK.
 */
export const requestEnumeratorPasswordReset = onCall(
  { region: 'us-central1', cors: true },
  async (request) => {
    const email = normalizeEmail(request.data?.email);
    const phone = normalizePhoneBd(request.data?.phone);
    if (!email || !phone) {
      throw new HttpsError('invalid-argument', 'Email and mobile number are required.');
    }

    let uid: string;
    let canonicalEmail: string;
    try {
      const userRecord = await admin.auth().getUserByEmail(email);
      uid = userRecord.uid;
      /** Must match Auth record exactly — `generatePasswordResetLink` is picky about casing vs normalized lookup. */
      canonicalEmail = (userRecord.email || email).trim();
    } catch {
      throw new HttpsError(
        'not-found',
        'No enumerator account matches this email and mobile number.'
      );
    }

    const snap = await firestoreForUsers().collection('users').doc(uid).get();
    if (!snap.exists) {
      throw new HttpsError(
        'failed-precondition',
        'Profile not found for this account. Please contact an administrator.'
      );
    }

    const data = snap.data()!;
    if (data.role !== 'enumerator') {
      throw new HttpsError(
        'permission-denied',
        'This reset option is only for enumerator accounts. Contact an administrator.'
      );
    }

    if (String(data.uid ?? '') !== uid) {
      logger.warn('users doc uid mismatch', { uid });
      throw new HttpsError(
        'permission-denied',
        'The email and mobile number do not match our records.'
      );
    }

    const profileEmail = String(data.email ?? '')
      .trim()
      .toLowerCase();
    if (profileEmail && profileEmail !== email) {
      throw new HttpsError(
        'permission-denied',
        'The email and mobile number do not match our records.'
      );
    }

    const storedPhone = normalizePhoneBd(data.mobileNumber);
    if (!storedPhone || storedPhone !== phone) {
      throw new HttpsError(
        'permission-denied',
        'The email and mobile number do not match our records.'
      );
    }

    const webApiKey = resolveWebApiKey();
    let sendEmailError: Error | undefined;
    if (webApiKey) {
      try {
        await sendPasswordResetOob(canonicalEmail, webApiKey);
        return { emailSent: true as const, resetLink: undefined as string | undefined };
      } catch (oobErr) {
        sendEmailError = oobErr instanceof Error ? oobErr : new Error(String(oobErr));
        logger.error('sendPasswordResetOob failed, trying reset link', sendEmailError);
      }
    } else {
      logger.warn('No WEB_API_KEY in env and no applet-config.runtime.json; run `npm run build` in functions/ before deploy');
    }

    try {
      const resetLink = await generatePasswordResetLinkReliable(canonicalEmail);
      return { emailSent: false as const, resetLink };
    } catch (e) {
      const linkDetail = describeLinkGenerationFailure(e);
      const adminCode =
        typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: string }).code) : '';
      const adminMsg =
        e instanceof Error ? e.message : typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);

      const parts: string[] = [linkDetail];
      if (sendEmailError) {
        parts.push(`Email (Identity Toolkit): ${sendEmailError.message}`);
      }
      parts.push(`Reset link (Admin SDK)${adminCode ? ` [${adminCode}]` : ''}: ${adminMsg}`);
      parts.push(
        'Tip: Web API keys restricted to “HTTP referrers” block server-side Identity Toolkit calls — relax restrictions or create a server-only key with Identity Toolkit API enabled.'
      );

      const fullMessage = parts.join(' ');
      throw new HttpsError('internal', fullMessage, parts);
    }
  }
);
