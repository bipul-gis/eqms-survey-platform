import React, { useState } from 'react';
import { useAuth } from './AuthProvider';
import { LogIn, Map as MapIcon, ShieldCheck, Users, Mail, Lock, AlertCircle, User as UserIcon, CheckCircle2, Phone } from 'lucide-react';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import { doc, setDoc } from 'firebase/firestore';

export const LoginScreen: React.FC = () => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [signUpSuccess, setSignUpSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (isSignUp) {
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
      
      // Save profile to Firestore with pending status
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

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 font-sans">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200 mb-4">
            <MapIcon size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Spatial Enumerator Pro</h1>
          <p className="text-slate-400 text-center mt-2 text-sm">
            City Corporation Internal GIS Portal
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 mb-6">
          {isSignUp && (
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

          {isSignUp && (
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">Mobile Number</label>
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
          </div>

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

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-semibold py-4 rounded-2xl flex items-center justify-center gap-3 hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 active:scale-[0.98] disabled:opacity-50"
          >
            {loading ? (isSignUp ? 'Creating Account...' : 'Signing in...') : <><LogIn size={20} /> {isSignUp ? 'Create Account' : 'Sign In'}</>}
          </button>
        </form>

        <div className="text-center mb-4">
          <button
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError(null);
              setSignUpSuccess(false);
              setEmail('');
              setPassword('');
              setName('');
              setMobileNumber('');
            }}
            className="text-blue-600 text-sm font-medium hover:underline"
          >
            {isSignUp ? 'Already have an account? Sign In' : 'New Enumerator? Sign Up'}
          </button>
        </div>

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

        <p className="text-[10px] text-slate-400 text-center mt-6 uppercase tracking-wider">
          Authorized Access Only
        </p>
      </div>
    </div>
  );
};
