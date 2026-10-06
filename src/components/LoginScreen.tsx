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

const REMEMBER_LOGIN_KEY = 'eqms.geosurvey.rememberLogin';
const REMEMBERED_EMAIL_KEY = 'eqms.geosurvey.rememberedEmail';
const REMEMBERED_PASSWORD_KEY = 'eqms.geosurvey.rememberedPassword';

// Base64 keeps the stored password out of plain sight in devtools. It is
// obfuscation, not encryption — anyone with the unlocked device can recover it.
function encodeSecret(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function decodeSecret(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0)));
}

function readRememberedLogin(): { remember: boolean; email: string; password: string } {
  try {
    const remember = localStorage.getItem(REMEMBER_LOGIN_KEY) === '1';
    if (!remember) return { remember: false, email: '', password: '' };
    const email = String(localStorage.getItem(REMEMBERED_EMAIL_KEY) || '').trim();
    const stored = localStorage.getItem(REMEMBERED_PASSWORD_KEY) || '';
    let password = '';
    try {
      password = stored ? decodeSecret(stored) : '';
    } catch {
      password = '';
    }
    return { remember, email, password };
  } catch {
    return { remember: false, email: '', password: '' };
  }
}

function persistRememberedLogin(remember: boolean, email: string, password: string) {
  try {
    if (remember && email.trim()) {
      localStorage.setItem(REMEMBER_LOGIN_KEY, '1');
      localStorage.setItem(REMEMBERED_EMAIL_KEY, email.trim());
      if (password) {
        localStorage.setItem(REMEMBERED_PASSWORD_KEY, encodeSecret(password));
      } else {
        localStorage.removeItem(REMEMBERED_PASSWORD_KEY);
      }
    } else {
      localStorage.removeItem(REMEMBER_LOGIN_KEY);
      localStorage.removeItem(REMEMBERED_EMAIL_KEY);
      localStorage.removeItem(REMEMBERED_PASSWORD_KEY);
    }
  } catch {
    /* ignore quota / private mode */
  }
}

export const LoginScreen: React.FC = () => {
  const { login } = useAuth();
  const remembered = readRememberedLogin();
  const [email, setEmail] = useState(remembered.email);
  const [password, setPassword] = useState(remembered.password);
  const [rememberLogin, setRememberLogin] = useState(remembered.remember);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ScreenMode>('login');
  const [name, setName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [forgotStep, setForgotStep] = useState<1 | 2>(1);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signUpSuccess, setSignUpSuccess] = useState(false);
  const [resetSuccessMessage, setResetSuccessMessage] = useState<string | null>(null);

  const mapForgotPasswordError = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.status === 400) {
        return err.message || 'Enter both registered email and mobile number.';
      }
      if (err.status === 403) {
        return 'The email and mobile number do not match our records.';
      }
      if (err.status === 404) {
        return 'No account matches this email and mobile number.';
      }
      if (err.status >= 500) {
        return 'Service is unavailable right now. Please try again later or contact an administrator.';
      }
    }
    return err instanceof Error ? err.message : 'Request failed';
  };

  const handleVerifyIdentity = async () => {
    setError(null);
    setEmailError(null);
    const em = email.trim();
    const phone = mobileNumber.trim();
    if (!em || !phone) {
      setError('Enter your registered email and mobile number.');
      throw new Error('validation');
    }
    const data = await geosurveyApi.forgotPassword(em, phone);
    if (data?.resetToken) {
      setResetToken(data.resetToken);
      setForgotStep(2);
      setError(null);
      return;
    }
    throw new Error('Identity verification failed');
  };

  const handleCompleteReset = async () => {
    setError(null);
    if (!resetToken) {
      setError('Verification session expired. Please verify your email and mobile again.');
      setForgotStep(1);
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirm password do not match.');
      return;
    }

    const data = await geosurveyApi.resetPassword(resetToken, newPassword);
    setResetSuccessMessage(data.message || 'Password successfully changed! You can now log in.');
    // Prepare for login
    setPassword(newPassword);
    setForgotStep(1);
    setResetToken(null);
    setNewPassword('');
    setConfirmPassword('');
    setMode('login');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setEmailError(null);

    if (mode === 'forgot') {
      try {
        if (forgotStep === 1) {
          const trimmedEmail = email.trim();
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
            setEmailError('Enter a valid email address');
            setLoading(false);
            return;
          }
          await handleVerifyIdentity();
        } else {
          await handleCompleteReset();
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'validation') return;
        setError(mapForgotPasswordError(err));
      } finally {
        setLoading(false);
      }
      return;
    }

    const trimmedEmail = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
      setEmailError('Enter a valid email address');
      setLoading(false);
      return;
    }

    try {
      if (mode === 'signup') {
        await handleSignUp();
      } else {
        await login(trimmedEmail, password);
        persistRememberedLogin(rememberLogin, trimmedEmail, password);
      }
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect email or password');
        persistRememberedLogin(rememberLogin, email, '');
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
    setEmailError(null);
    setSignUpSuccess(false);
    setResetSuccessMessage(null);
  };

  const goForgot = () => {
    setMode('forgot');
    setForgotStep(1);
    setResetToken(null);
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setEmailError(null);
    setResetSuccessMessage(null);
  };

  const goLogin = () => {
    setMode('login');
    setForgotStep(1);
    setResetToken(null);
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setEmailError(null);
  };

  const submitLabel =
    mode === 'forgot'
      ? loading
        ? forgotStep === 1
          ? 'Checking details…'
          : 'Updating password…'
        : forgotStep === 1
          ? 'Verify Identity'
          : 'Save New Password'
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
              ? forgotStep === 1
                ? 'Step 1 of 2: Verify your registered email and mobile number.'
                : 'Step 2 of 2: Enter your new password.'
              : 'Collect and validate geospatial data from ground level'}
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4 mb-6">
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

          {/* Mobile input: Signup or Forgot Step 1 */}
          {(mode === 'signup' || (mode === 'forgot' && forgotStep === 1)) && (
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                Registered Mobile Number <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="tel"
                  value={mobileNumber}
                  onChange={(e) => {
                    setMobileNumber(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="01XXXXXXXXX"
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                  required
                />
              </div>
            </div>
          )}

          {/* Email input: Login, Signup, or Forgot Step 1 */}
          {(mode !== 'forgot' || forgotStep === 1) && (
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                {mode === 'forgot' ? 'Registered Email' : 'Email'}
              </label>
              <div className="relative">
                <Mail className={`absolute left-3 top-1/2 -translate-y-1/2 ${emailError ? 'text-red-400' : 'text-slate-400'}`} size={18} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError(null);
                    if (error) setError(null);
                  }}
                  autoComplete="email"
                  placeholder="Enter your registered email"
                  className={`w-full pl-10 pr-4 py-3 bg-slate-50 border rounded-xl outline-none transition-all text-sm ${
                    emailError
                      ? 'border-red-400 focus:ring-2 focus:ring-red-400 focus:border-red-400 bg-red-50/20'
                      : 'border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
                  }`}
                  required
                />
              </div>
              {emailError && (
                <p className="text-xs text-red-500 font-medium mt-1.5 ml-1 flex items-center gap-1.5 animate-in fade-in slide-in-from-top-1 duration-150">
                  <AlertCircle size={14} className="shrink-0" />
                  {emailError}
                </p>
              )}
            </div>
          )}

          {/* Forgot Step 2: New Password & Confirm Password */}
          {mode === 'forgot' && forgotStep === 2 && (
            <>
              <div className="bg-emerald-50 border border-emerald-100 p-3 rounded-xl text-xs text-emerald-800 flex items-center gap-2">
                <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
                <span>Identity verified for <strong>{email}</strong>. Enter your new password below.</span>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">New Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => {
                      setNewPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    autoComplete="new-password"
                    placeholder="Enter new password (min 6 characters)"
                    className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">Confirm New Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    autoComplete="new-password"
                    placeholder="Confirm your new password"
                    className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                    required
                  />
                </div>
              </div>
            </>
          )}

          {/* Normal Password Input */}
          {mode !== 'forgot' && (
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  placeholder="Enter your password"
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                  required
                />
              </div>
              {mode === 'login' && (
                <div className="flex items-center justify-between gap-2 mt-2">
                  <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={rememberLogin}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setRememberLogin(on);
                        if (!on) persistRememberedLogin(false, '', '');
                      }}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    Remember me
                  </label>
                  <button
                    type="button"
                    onClick={goForgot}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline inline-flex items-center gap-1 shrink-0"
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

          {resetSuccessMessage && (
            <div className="bg-green-50 text-green-700 p-3 rounded-xl text-xs flex items-center gap-2 border border-green-100 leading-relaxed font-medium">
              <CheckCircle2 size={20} className="shrink-0 text-green-600" />
              {resetSuccessMessage}
            </div>
          )}

          {signUpSuccess && (
            <div className="bg-green-50 text-green-600 p-3 rounded-xl text-xs flex items-center gap-2 border border-green-100 leading-relaxed font-medium">
              <CheckCircle2 size={20} className="shrink-0" />
              Account created successfully! Your account is pending admin approval. You will be notified once approved.
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
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
