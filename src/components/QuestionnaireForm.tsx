import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { Questionnaire, QuestionnaireResponse, Question } from '../types';
import { MapPin, Save, Send, CheckCircle, AlertCircle, Calendar, FileText } from 'lucide-react';
import { collection, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';

interface QuestionnaireFormProps {
  questionnaire: Questionnaire;
  onClose: () => void;
  onSubmit?: (response: QuestionnaireResponse) => void;
  initialLocation?: { lat: number; lng: number; ward?: string };
}

export const QuestionnaireForm: React.FC<QuestionnaireFormProps> = ({
  questionnaire,
  onClose,
  onSubmit,
  initialLocation
}) => {
  const { user, userProfile } = useAuth();
  const [responses, setResponses] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [currentLocation, setCurrentLocation] = useState(initialLocation);

  useEffect(() => {
    if (initialLocation) {
      setCurrentLocation(initialLocation);
    }
  }, [initialLocation]);

  const validateQuestion = (question: Question, value: any): string | null => {
    if (question.required && (!value || (Array.isArray(value) && value.length === 0))) {
      return 'This field is required';
    }

    if (value && question.validation) {
      if (question.type === 'number') {
        const num = Number(value);
        if (question.validation.min !== undefined && num < question.validation.min) {
          return `Value must be at least ${question.validation.min}`;
        }
        if (question.validation.max !== undefined && num > question.validation.max) {
          return `Value must be at most ${question.validation.max}`;
        }
      }
      if (question.validation.pattern && !new RegExp(question.validation.pattern).test(value)) {
        return 'Invalid format';
      }
    }

    return null;
  };

  const handleInputChange = (questionId: string, value: any) => {
    setResponses(prev => ({ ...prev, [questionId]: value }));
    setErrors(prev => ({ ...prev, [questionId]: '' }));
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    let isValid = true;

    questionnaire.questions.forEach(question => {
      const error = validateQuestion(question, responses[question.id]);
      if (error) {
        newErrors[question.id] = error;
        isValid = false;
      }
    });

    setErrors(newErrors);
    return isValid;
  };

  const handleSaveDraft = async () => {
    if (!user || !userProfile) return;

    setLoading(true);
    try {
      const responseData: Omit<QuestionnaireResponse, 'id'> = {
        questionnaireId: questionnaire.id,
        respondentId: user.uid,
        respondentName: userProfile.displayName,
        location: currentLocation,
        responses,
        status: 'draft'
      };

      await addDoc(collection(db, 'questionnaireResponses'), responseData);
      alert('Draft saved successfully!');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'questionnaireResponses');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!user || !userProfile) return;

    if (!validateForm()) {
      alert('Please fix the errors before submitting');
      return;
    }

    setLoading(true);
    try {
      const responseData: Omit<QuestionnaireResponse, 'id'> = {
        questionnaireId: questionnaire.id,
        respondentId: user.uid,
        respondentName: userProfile.displayName,
        location: currentLocation,
        responses,
        status: 'submitted',
        submittedAt: serverTimestamp()
      };

      const docRef = await addDoc(collection(db, 'questionnaireResponses'), responseData);

      if (onSubmit) {
        onSubmit({ ...responseData, id: docRef.id } as QuestionnaireResponse);
      }

      alert('Questionnaire submitted successfully!');
      onClose();
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'questionnaireResponses');
    } finally {
      setLoading(false);
    }
  };

  const renderQuestion = (question: Question) => {
    const value = responses[question.id];
    const error = errors[question.id];

    const baseInputClasses = "w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500";
    const errorClasses = error ? "border-red-300" : "border-gray-300";

    switch (question.type) {
      case 'text':
        return (
          <input
            type="text"
            value={value || ''}
            onChange={(e) => handleInputChange(question.id, e.target.value)}
            placeholder={question.placeholder}
            className={`${baseInputClasses} ${errorClasses}`}
          />
        );

      case 'number':
        return (
          <input
            type="number"
            value={value || ''}
            onChange={(e) => handleInputChange(question.id, e.target.value)}
            placeholder={question.placeholder}
            min={question.validation?.min}
            max={question.validation?.max}
            className={`${baseInputClasses} ${errorClasses}`}
          />
        );

      case 'date':
        return (
          <input
            type="date"
            value={value || ''}
            onChange={(e) => handleInputChange(question.id, e.target.value)}
            className={`${baseInputClasses} ${errorClasses}`}
          />
        );

      case 'select':
        return (
          <select
            value={value || ''}
            onChange={(e) => handleInputChange(question.id, e.target.value)}
            className={`${baseInputClasses} ${errorClasses}`}
          >
            <option value="">Select an option</option>
            {question.options?.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        );

      case 'radio':
        return (
          <div className="space-y-2">
            {question.options?.map(option => (
              <label key={option} className="flex items-center space-x-2">
                <input
                  type="radio"
                  name={question.id}
                  value={option}
                  checked={value === option}
                  onChange={(e) => handleInputChange(question.id, e.target.value)}
                  className="text-blue-600 focus:ring-blue-500"
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        );

      case 'checkbox':
        return (
          <div className="space-y-2">
            {question.options?.map(option => (
              <label key={option} className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  value={option}
                  checked={Array.isArray(value) && value.includes(option)}
                  onChange={(e) => {
                    const currentValues = Array.isArray(value) ? value : [];
                    const newValues = e.target.checked
                      ? [...currentValues, option]
                      : currentValues.filter(v => v !== option);
                    handleInputChange(question.id, newValues);
                  }}
                  className="text-blue-600 focus:ring-blue-500"
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        );

      default:
        return <div>Unsupported question type</div>;
    }
  };

  return (
    <div className="flex flex-col h-full bg-white shadow-2xl border-l border-gray-200 w-full md:w-96">
      <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-blue-600" />
          <div>
            <h2 className="font-semibold text-gray-800">{questionnaire.title}</h2>
            <p className="text-xs text-gray-500">v{questionnaire.version}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
          <AlertCircle size={20} className="text-gray-500" />
        </button>
      </div>

      <div className="p-4 border-b border-gray-100 bg-blue-50">
        <p className="text-sm text-gray-700">{questionnaire.description}</p>
        {currentLocation && (
          <div className="flex items-center gap-2 mt-2 text-xs text-gray-600">
            <MapPin size={14} />
            <span>Location: {currentLocation.lat.toFixed(6)}, {currentLocation.lng.toFixed(6)}</span>
            {currentLocation.ward && <span>• Ward: {currentLocation.ward}</span>}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {questionnaire.questions.map((question, index) => (
          <div key={question.id} className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              {index + 1}. {question.question}
              {question.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            {renderQuestion(question)}
            {errors[question.id] && (
              <p className="text-xs text-red-600 flex items-center gap-1">
                <AlertCircle size={12} />
                {errors[question.id]}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-gray-100 space-y-3">
        <div className="flex gap-2">
          <button
            onClick={handleSaveDraft}
            disabled={loading}
            className="flex-1 bg-gray-100 text-gray-700 font-medium py-2.5 rounded-lg hover:bg-gray-200 transition-colors flex items-center justify-center gap-2"
          >
            <Save size={16} />
            Save Draft
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 bg-blue-600 text-white font-medium py-2.5 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
          >
            <Send size={16} />
            {loading ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
};