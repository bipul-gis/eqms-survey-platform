import React, { useState } from 'react';
import {
  X,
  User,
  Mail,
  Phone,
  Lock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  KeyRound,
  Shield,
} from 'lucide-react';
import { useAuth } from './AuthProvider';
import { geosurveyApi, ApiError } from '../lib/geosurveyApi';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ProfileModal: React.FC<ProfileModalProps> = ({ isOpen, onClose }) => {
  const { user, userProfile, refreshProfile } = useAuth();

  const [activeTab, setActiveTab] = useState<'info' | 'password'>('info');

  // Info form
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoSuccess, setInfoSuccess] = useState<string | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  // Password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passLoading, setPassLoading] = useState(false);
  const [passSuccess, setPassSuccess] = useState<string | null>(null);
  const [passError, setPassError] = useState<string | null>(null);

  // Sync inputs on open
  React.useEffect(() => {
    if (isOpen && userProfile) {
      setDisplayName(userProfile.displayName || '');
      setEmail(userProfile.email || user?.email || '');
      setMobileNumber(userProfile.mobileNumber || '');
      setInfoSuccess(null);
      setInfoError(null);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPassSuccess(null);
      setPassError(null);
    }
  }, [isOpen, userProfile, user]);

  if (!isOpen || !userProfile) return null;

  // Change detection
  const isInfoDirty =
    (displayName.trim() !== (userProfile.displayName || '').trim()) ||
    (email.trim().toLowerCase() !== (userProfile.email || user?.email || '').trim().toLowerCase()) ||
    (mobileNumber.trim() !== (userProfile.mobileNumber || '').trim());

  const isPassDirty = Boolean(currentPassword || newPassword || confirmPassword);
  const isPassValid =
    Boolean(currentPassword) &&
    Boolean(newPassword) &&
    newPassword.length >= 6 &&
    newPassword === confirmPassword;

  const handleUpdateInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    setInfoLoading(true);
    setInfoError(null);
    setInfoSuccess(null);

    const normEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!normEmail || !emailRegex.test(normEmail)) {
      setInfoError('Please enter a valid email address.');
      setInfoLoading(false);
      return;
    }

    try {
      await geosurveyApi.updateUser(userProfile.uid, {
        displayName: displayName.trim(),
        email: normEmail,
        mobileNumber: mobileNumber.trim() || undefined,
      });
      await refreshProfile();
      setInfoSuccess('Profile details successfully updated.');
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setInfoError(err.message);
      } else if (err instanceof Error) {
        setInfoError(err.message);
      } else {
        setInfoError('Failed to update profile.');
      }
    } finally {
      setInfoLoading(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassLoading(true);
    setPassError(null);
    setPassSuccess(null);

    if (!currentPassword) {
      setPassError('Please enter your current password.');
      setPassLoading(false);
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      setPassError('New password must be at least 6 characters.');
      setPassLoading(false);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPassError('New password and confirm password do not match.');
      setPassLoading(false);
      return;
    }

    try {
      await geosurveyApi.changeUserPassword(userProfile.uid, {
        currentPassword,
        newPassword,
      });
      setPassSuccess('Password successfully changed.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setPassError(err.message);
      } else if (err instanceof Error) {
        setPassError(err.message);
      } else {
        setPassError('Failed to change password.');
      }
    } finally {
      setPassLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-white rounded-3xl shadow-2xl border border-slate-100 max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-md shadow-blue-200">
              <User size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">My Profile</h2>
              <p className="text-xs text-slate-500">
                {userProfile.role === 'admin' ? 'Administrator' : 'Field Enumerator'} · {userProfile.email}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tab switch */}
        <div className="flex border-b border-slate-100 px-6 pt-3 gap-6 bg-slate-50/20">
          <button
            type="button"
            onClick={() => setActiveTab('info')}
            className={`pb-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all ${
              activeTab === 'info'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            <User size={16} /> Personal Information
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('password')}
            className={`pb-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all ${
              activeTab === 'password'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            <KeyRound size={16} /> Change Password
          </button>
        </div>

        {/* Content body */}
        <div className="p-6 overflow-y-auto flex-1">
          {activeTab === 'info' && (
            <form onSubmit={handleUpdateInfo} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                  Full Name
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your Full Name"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@organization.com"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                  Mobile Number
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="tel"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    placeholder="01XXXXXXXXX"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                  />
                </div>
                <p className="text-[10px] text-slate-400 mt-1 ml-1">
                  Used for account identification and password recovery verification.
                </p>
              </div>

              {/* Status and Role Badges */}
              <div className="pt-2 flex items-center gap-3">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                  <Shield size={12} /> Role: {userProfile.role.toUpperCase()}
                </span>
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <CheckCircle2 size={12} /> Status: {userProfile.status.toUpperCase()}
                </span>
              </div>

              {infoError && (
                <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs flex items-center gap-2 border border-red-100">
                  <AlertCircle size={16} className="shrink-0" />
                  {infoError}
                </div>
              )}

              {infoSuccess && (
                <div className="bg-green-50 text-green-700 p-3 rounded-xl text-xs flex items-center gap-2 border border-green-100">
                  <CheckCircle2 size={16} className="shrink-0 text-green-600" />
                  {infoSuccess}
                </div>
              )}

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={infoLoading || !isInfoDirty}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-all shadow-md shadow-blue-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:transform-none flex items-center justify-center gap-2 text-sm"
                >
                  {infoLoading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Saving Changes...
                    </>
                  ) : (
                    'Save Profile Information'
                  )}
                </button>
              </div>
            </form>
          )}

          {activeTab === 'password' && (
            <form onSubmit={handleUpdatePassword} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                  Current Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                  New Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase ml-1 mb-1 block">
                  Confirm New Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm"
                    required
                  />
                </div>
              </div>

              {passError && (
                <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs flex items-center gap-2 border border-red-100">
                  <AlertCircle size={16} className="shrink-0" />
                  {passError}
                </div>
              )}

              {passSuccess && (
                <div className="bg-green-50 text-green-700 p-3 rounded-xl text-xs flex items-center gap-2 border border-green-100">
                  <CheckCircle2 size={16} className="shrink-0 text-green-600" />
                  {passSuccess}
                </div>
              )}

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={passLoading || !isPassDirty || !isPassValid}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-all shadow-md shadow-blue-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:transform-none flex items-center justify-center gap-2 text-sm"
                >
                  {passLoading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Updating Password...
                    </>
                  ) : (
                    'Update Password'
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
