import React, { useState } from 'react';
import { useAuth } from './AuthProvider';
import {
  LogIn,
  Map as MapIcon,
  ShieldCheck,
  Users,
  Mail,
  Lock,
  AlertCircle,
  User as UserIcon,
  CheckCircle2,
  Phone,
  KeyRound,
  ArrowLeft
} from 'lucide-react';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { httpsCallable, FunctionsError } from 'firebase/functions';
import { FirebaseError } from 'firebase/app';
import { auth, db, functions } from '../lib/firebase';
import { doc, setDoc } from 'firebase/firestore';

type ScreenMode = 'login' | 'signup' | 'forgot';

/** Callable errors often set `message` to the useless word "internal"; real text may live in `details`. */
function extractFirebaseCallableMessage(err: unknown): string | undefined {
  const useless = (s: string | undefined) =>
    !s?.trim() || /^internal$/i.test(s.trim()) || s.trim() === 'INTERNAL';

  if (err instanceof FunctionsError) {
    const direct = err.message?.trim();
    if (!useless(direct)) return direct;

    const walk = (d: unknown): string | undefined => {
      if (typeof d === 'string') {
        const t = d.trim();
        if (t.length > 3 && !/^internal$/i.test(t)) return t;
      }
      if (Array.isArray(d)) {
        const chunks: string[] = [];
        for (const x of d) {
          if (typeof x === 'string') {
            const t = x.trim();
            if (t.length > 3 && !/^internal$/i.test(t)) chunks.push(t);
          } else {
            const r = walk(x);
            if (r) chunks.push(r);
          }
        }
        if (chunks.length) return chunks.join(' — ');
      }
      if (d && typeof d === 'object') {
        const o = d as Record<string, unknown>;
        for (const key of ['message', 'Message', 'reason']) {
          const v = o[key];
          if (typeof v === 'string') {
            const r = walk(v);
            if (r) return r;
          }
        }
        for (const v of Object.values(o)) {
          const r = walk(v);
          if (r) return r;
        }
      }
      return undefined;
    };

    const fromDetails = walk(err.details);
    if (fromDetails) return fromDetails;
  }

  if (err instanceof FirebaseError) {
    const m = err.message?.trim();
    if (!useless(m)) return m;
  }

  return undefined;
}

const DEFAULT_FORGOT_INTERNAL =
  'Password reset failed (no detail from server). Confirm `firebase deploy --only functions` succeeded, functions region is us-central1, and Authentication → Templates → Password reset is saved. For API errors about the key: Google Cloud → Credentials → your Browser key → Application restrictions: none or “IP addresses” for Cloud Functions egress — not “HTTP referrers” only.';

export const LoginScreen: React.FC = () => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ScreenMode>('login');
  const [name, setName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [signUpSuccess, setSignUpSuccess] = useState(false);
  const [forgotResetLink, setForgotResetLink] = useState<string | null>(null);
  const [forgotEmailSent, setForgotEmailSent] = useState(false);

  const mapForgotPasswordError = (err: unknown): string => {
    if (err instanceof FirebaseError) {
      const c = err.code;
      if (c === 'functions/not-found') {
        return 'No enumerator account matches this email and mobile number.';
      }
      if (c === 'functions/permission-denied') {
        return 'The email and mobile number do not match our records.';
      }
      if (c === 'functions/failed-precondition') {
        return 'Profile not found for this account. Please contact an administrator.';
      }
      if (c === 'functions/invalid-argument') {
        return 'Enter both email and the mobile number you registered with.';
      }
      if (c === 'functions/internal') {
        return extractFirebaseCallableMessage(err) ?? DEFAULT_FORGOT_INTERNAL;
      }
      if (c === 'functions/unavailable' || c === 'functions/deadline-exceeded') {
        return 'Password reset service is unavailable. If this continues, ask your administrator to deploy Cloud Functions.';
      }
    }
    const extracted = extractFirebaseCallableMessage(err);
    if (extracted) return extracted;
    return err instanceof Error ? err.message : 'Request failed';
  };

  const handleForgotPassword = async () => {
    setForgotResetLink(null);
    setForgotEmailSent(false);
    const em = email.trim();
    const phone = mobileNumber.trim();
    if (!em || !phone) {
      setError('Enter your registered email and mobile number.');
      throw new Error('validation');
    }
    const requestEnumeratorPasswordReset = httpsCallable<
      { email: string; phone: string },
      { resetLink?: string; emailSent?: boolean }
    >(functions, 'requestEnumeratorPasswordReset');
    const result = await requestEnumeratorPasswordReset({ email: em, phone });
    const data = result.data;
    if (data?.emailSent) {
      setForgotEmailSent(true);
      return;
    }
    const link = data?.resetLink;
    if (link) setForgotResetLink(link);
    else setError('Reset was not completed. Try again or contact an administrator.');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === 'forgot') {
        try {
          await handleForgotPassword();
        } catch (err: unknown) {
          if (err instanceof Error && err.message === 'validation') return;
          setError(mapForgotPasswordError(err));
        }
        return;
      }
      if (mode === 'signup') {
        await handleSignUp();
      } else {
        await login(email, password);
      }
    } catch (err: any) {
      if (err.code === 'auth/operation-not-allowed') {
        setError('CRITICAL: Email/Password login is DISABLED in Firebase Console. Go to Authentication -> Sign-in Method to enable it.');
      } else if (err.code === 'auth/invalid-credential') {
        setError('Incorrect username or password.');
      } else if (err.code === 'auth/user-not-found') {
        setError('No account found with this email.');
      } else if (err.code === 'auth/user-disabled') {
        setError('Your account has been disabled. Please contact an administrator.');
      } else {
        setError(err.message || 'Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);

      await setDoc(doc(db, 'users', userCredential.user.uid), {
        uid: userCredential.user.uid,
        email,
        displayName: name,
        mobileNumber,
        role: 'enumerator',
        status: 'pending'
      });

      setSignUpSuccess(true);
      setEmail('');
      setPassword('');
      setName('');
      setMobileNumber('');
    } catch (err: any) {
      throw err;
    }
  };

  const switchLoginSignup = () => {
    setMode(mode === 'signup' ? 'login' : 'signup');
    setError(null);
    setSignUpSuccess(false);
    setForgotResetLink(null);
  };

  const goForgot = () => {
    setMode('forgot');
    setError(null);
    setForgotResetLink(null);
    setForgotEmailSent(false);
  };

  const goLogin = () => {
    setMode('login');
    setError(null);
    setForgotResetLink(null);
    setForgotEmailSent(false);
  };

  const submitLabel =
    mode === 'forgot'
      ? loading
        ? 'Verifying…'
        : 'Verify & open password reset'
      : loading
        ? mode === 'signup'
          ? 'Creating Account...'
          : 'Signing in...'
        : mode === 'signup'
          ? 'Create Account'
          : 'Sign In';

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 font-sans">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200 mb-4">
            <MapIcon size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">EQMS Geosurvey</h1>
          <p className="text-slate-400 text-center mt-2 text-sm">
            {mode === 'forgot'
              ? 'Confirm your registered email and mobile to get a password reset link.'
              : 'Collect and validate geospatial data from ground level'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 mb-6">
          {mode === 'signup' && (
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">Full Name</label>
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Doe"
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                  required
                />
              </div>
            </div>
          )}

          {(mode === 'signup' || mode === 'forgot') && (
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                Mobile Number <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="tel"
                  value={mobileNumber}
                  onChange={(e) => setMobileNumber(e.target.value)}
                  placeholder="01XXXXXXXXX"
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                  required
                />
              </div>
              {mode === 'forgot' && (
                <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">
                  Must match the mobile number on your enumerator profile (same account as your email).
                </p>
              )}
            </div>
          )}

          <div>
            <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">Email / Username</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@ccc.gov.bd"
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                required
              />
            </div>
          </div>

          {mode !== 'forgot' && (
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                  required
                />
              </div>
              {mode === 'login' && (
                <div className="flex justify-end mt-1.5">
                  <button
                    type="button"
                    onClick={goForgot}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline inline-flex items-center gap-1"
                  >
                    <KeyRound size={12} />
                    Forgot password?
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs flex items-center gap-2 border border-red-100 leading-relaxed font-medium">
              <AlertCircle size={20} className="shrink-0" />
              {error}
            </div>
          )}

          {signUpSuccess && (
            <div className="bg-green-50 text-green-600 p-3 rounded-xl text-xs flex items-center gap-2 border border-green-100 leading-relaxed font-medium">
              <CheckCircle2 size={20} className="shrink-0" />
              Account created successfully! Your account is pending admin approval. You will be notified once approved.
            </div>
          )}

          {forgotEmailSent && (
            <div className="bg-green-50 text-green-800 p-3 rounded-xl text-xs border border-green-100 space-y-2">
              <p className="font-semibold flex items-center gap-2">
                <CheckCircle2 size={18} />
                Verified. Check your email inbox for a password reset message from Firebase (also check spam).
              </p>
            </div>
          )}

          {forgotResetLink && (
            <div className="bg-green-50 text-green-800 p-3 rounded-xl text-xs border border-green-100 space-y-2">
              <p className="font-semibold flex items-center gap-2">
                <CheckCircle2 size={18} />
                Verified. Open the link below to set a new password.
              </p>
              <a
                href={forgotResetLink}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-green-600 text-white font-semibold py-2.5 rounded-xl hover:bg-green-700 transition-colors"
              >
                Open password reset page
              </a>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || Boolean(forgotResetLink) || forgotEmailSent}
            className="w-full bg-blue-600 text-white font-semibold py-4 rounded-2xl flex items-center justify-center gap-3 hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 active:scale-[0.98] disabled:opacity-50"
          >
            {submitLabel}
          </button>

          {mode === 'forgot' && (
            <button
              type="button"
              onClick={goLogin}
              className="w-full text-slate-600 text-sm font-medium py-2 flex items-center justify-center gap-2 hover:text-slate-800"
            >
              <ArrowLeft size={16} />
              Back to sign in
            </button>
          )}
        </form>

        {mode !== 'forgot' && (
          <div className="text-center mb-4">
            <button
              type="button"
              onClick={switchLoginSignup}
              className="text-blue-600 text-sm font-medium hover:underline"
            >
              {mode === 'signup' ? 'Already have an account? Sign In' : 'New Enumerator? Sign Up'}
            </button>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
            <Users className="text-blue-500" size={18} />
            <div className="text-xs">
              <p className="font-semibold text-slate-700">Multi-User Sync</p>
              <p className="text-slate-500">Real-time collaborative GIS editing</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
            <ShieldCheck className="text-green-500" size={18} />
            <div className="text-xs">
              <p className="font-semibold text-slate-700">Data Quality</p>
              <p className="text-slate-500">Admin verification and GPS checks</p>
            </div>
          </div>
        </div>

        <p className="text-[10px] text-slate-400 text-center mt-6 uppercase tracking-wider">Authorized Access Only</p>
      </div>
    </div>
  );
};
