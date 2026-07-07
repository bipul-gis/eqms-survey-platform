import React, { useState } from 'react';
import { useAuth } from './AuthProvider';
import { AppFooter } from './AppFooter';
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
import { ApiError, geosurveyApi } from '../lib/geosurveyApi';

type ScreenMode = 'login' | 'signup' | 'forgot';

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
    if (err instanceof ApiError) {
      if (err.status === 400) {
        return 'Enter both email and the mobile number you registered with.';
      }
      if (err.status === 403) {
        return 'The email and mobile number do not match our records.';
      }
      if (err.status === 404) {
        return 'No enumerator account matches this email and mobile number.';
      }
      if (err.status >= 500) {
        return 'Password reset service is unavailable right now. Please try again later or contact an administrator.';
      }
    }
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
    const data = await geosurveyApi.forgotPassword(em, phone);
    if (data?.temporaryPassword) {
      setForgotResetLink(`Temporary password: ${data.temporaryPassword}`);
      return;
    }
    if (data?.ok) {
      setForgotEmailSent(true);
      return;
    }
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
      if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect username or password.');
      } else if (err instanceof ApiError && err.status === 403) {
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
      await geosurveyApi.register({
        email,
        password,
        displayName: name,
        mobileNumber
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
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100">
        <div className="flex flex-col items-center mb-8">
          <img
            src="/eqms-logo.png"
            alt="EQMS"
            className="h-14 w-auto mb-3 select-none"
            draggable={false}
          />
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <span>Geosurvey</span>
          </h1>
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
                Verified. Check your email inbox for a password reset message.
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
      <AppFooter className="border-t border-slate-200 bg-white/70 backdrop-blur" />
    </div>
  );
};
