import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { Questionnaire, Question, QuestionType } from '../types';
import { FileText, Plus, Edit, Trash2, Eye, X, Save, AlertCircle, CheckCircle } from 'lucide-react';
import { collection, addDoc, updateDoc, deleteDoc, doc, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';

interface QuestionnaireManagerProps {
  onClose: () => void;
  onSelectQuestionnaire?: (questionnaire: Questionnaire) => void;
}

export const QuestionnaireManager: React.FC<QuestionnaireManagerProps> = ({ onClose, onSelectQuestionnaire }) => {
  const { user } = useAuth();
  const [questionnaires, setQuestionnaires] = useState<Questionnaire[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingQuestionnaire, setEditingQuestionnaire] = useState<Questionnaire | null>(null);

  useEffect(() => {
    fetchQuestionnaires();
  }, []);

  const fetchQuestionnaires = async () => {
    try {
      const q = query(collection(db, 'questionnaires'));
      const querySnapshot = await getDocs(q);
      const questionnairesData: Questionnaire[] = [];
      querySnapshot.forEach((doc) => {
        questionnairesData.push({ ...doc.data(), id: doc.id } as Questionnaire);
      });
      setQuestionnaires(questionnairesData);
    } catch (error) {
      console.error('Error fetching questionnaires:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (questionnaireId: string) => {
    if (!confirm('Are you sure you want to delete this questionnaire?')) return;

    try {
      await deleteDoc(doc(db, 'questionnaires', questionnaireId));
      setQuestionnaires(prev => prev.filter(q => q.id !== questionnaireId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'questionnaires');
    }
  };

  const toggleActive = async (questionnaire: Questionnaire) => {
    try {
      await updateDoc(doc(db, 'questionnaires', questionnaire.id), {
        isActive: !questionnaire.isActive,
        updatedAt: serverTimestamp()
      });
      setQuestionnaires(prev =>
        prev.map(q =>
          q.id === questionnaire.id
            ? { ...q, isActive: !q.isActive, updatedAt: new Date().toISOString() }
            : q
        )
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'questionnaires');
    }
  };

  if (showCreateForm) {
    return <QuestionnaireEditor onClose={() => setShowCreateForm(false)} onSave={fetchQuestionnaires} />;
  }

  if (editingQuestionnaire) {
    return (
      <QuestionnaireEditor
        questionnaire={editingQuestionnaire}
        onClose={() => setEditingQuestionnaire(null)}
        onSave={fetchQuestionnaires}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-white shadow-2xl border-l border-gray-200 w-full md:w-96">
      <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <FileText size={20} className="text-blue-600" />
          Questionnaire Manager
        </h2>
        <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
          <X size={20} className="text-gray-500" />
        </button>
      </div>

      <div className="p-4 border-b border-gray-100">
        <button
          onClick={() => setShowCreateForm(true)}
          className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
        >
          <Plus size={16} />
          Create New Questionnaire
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-6 text-center text-gray-500">Loading questionnaires...</div>
        ) : questionnaires.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            <FileText size={48} className="mx-auto mb-4 text-gray-300" />
            <p>No questionnaires created yet</p>
            <p className="text-sm">Click "Create New Questionnaire" to get started</p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {questionnaires.map(questionnaire => (
              <div key={questionnaire.id} className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-800">{questionnaire.title}</h3>
                    <p className="text-sm text-gray-600 mt-1">{questionnaire.description}</p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                      <span>v{questionnaire.version}</span>
                      <span>{questionnaire.questions.length} questions</span>
                      <span className={`flex items-center gap-1 ${questionnaire.isActive ? 'text-green-600' : 'text-gray-400'}`}>
                        {questionnaire.isActive ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                        {questionnaire.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  {onSelectQuestionnaire && (
                    <button
                      onClick={() => onSelectQuestionnaire(questionnaire)}
                      className="flex-1 bg-green-600 text-white text-xs font-medium py-2 rounded hover:bg-green-700 transition-colors flex items-center justify-center gap-1"
                    >
                      <Eye size={14} />
                      Use
                    </button>
                  )}
                  <button
                    onClick={() => setEditingQuestionnaire(questionnaire)}
                    className="flex-1 bg-blue-600 text-white text-xs font-medium py-2 rounded hover:bg-blue-700 transition-colors flex items-center justify-center gap-1"
                  >
                    <Edit size={14} />
                    Edit
                  </button>
                  <button
                    onClick={() => toggleActive(questionnaire)}
                    className={`px-3 py-2 rounded text-xs font-medium transition-colors ${
                      questionnaire.isActive
                        ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                        : 'bg-green-100 text-green-700 hover:bg-green-200'
                    }`}
                  >
                    {questionnaire.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    onClick={() => handleDelete(questionnaire.id)}
                    className="px-3 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Questionnaire Editor Component
interface QuestionnaireEditorProps {
  questionnaire?: Questionnaire;
  onClose: () => void;
  onSave: () => void;
}

const QuestionnaireEditor: React.FC<QuestionnaireEditorProps> = ({ questionnaire, onClose, onSave }) => {
  const { user } = useAuth();
  const [formData, setFormData] = useState({
    title: questionnaire?.title || '',
    description: questionnaire?.description || '',
    version: questionnaire?.version || '1.0',
    isActive: questionnaire?.isActive ?? true,
    questions: questionnaire?.questions || []
  });
  const [loading, setLoading] = useState(false);

  const addQuestion = () => {
    const newQuestion: Question = {
      id: `q_${Date.now()}`,
      type: 'text',
      question: '',
      required: false
    };
    setFormData(prev => ({
      ...prev,
      questions: [...prev.questions, newQuestion]
    }));
  };

  const updateQuestion = (index: number, updates: Partial<Question>) => {
    setFormData(prev => ({
      ...prev,
      questions: prev.questions.map((q, i) =>
        i === index ? { ...q, ...updates } : q
      )
    }));
  };

  const removeQuestion = (index: number) => {
    setFormData(prev => ({
      ...prev,
      questions: prev.questions.filter((_, i) => i !== index)
    }));
  };

  const handleSave = async () => {
    if (!user) return;

    if (!formData.title.trim() || formData.questions.length === 0) {
      alert('Please provide a title and at least one question');
      return;
    }

    setLoading(true);
    try {
      const questionnaireData = {
        ...formData,
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        ...(questionnaire ? {} : { createdAt: serverTimestamp() })
      };

      if (questionnaire) {
        await updateDoc(doc(db, 'questionnaires', questionnaire.id), questionnaireData);
      } else {
        await addDoc(collection(db, 'questionnaires'), questionnaireData);
      }

      onSave();
      onClose();
    } catch (error) {
      handleFirestoreError(error, questionnaire ? OperationType.UPDATE : OperationType.CREATE, 'questionnaires');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white shadow-2xl border-l border-gray-200 w-full md:w-96">
      <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <FileText size={20} className="text-blue-600" />
          {questionnaire ? 'Edit Questionnaire' : 'Create Questionnaire'}
        </h2>
        <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
          <X size={20} className="text-gray-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
          <input
            type="text"
            value={formData.title}
            onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="Questionnaire Title"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            value={formData.description}
            onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            rows={3}
            placeholder="Brief description of the questionnaire"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Version</label>
            <input
              type="text"
              value={formData.version}
              onChange={(e) => setFormData(prev => ({ ...prev, version: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="1.0"
            />
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="isActive"
              checked={formData.isActive}
              onChange={(e) => setFormData(prev => ({ ...prev, isActive: e.target.checked }))}
              className="text-blue-600 focus:ring-blue-500"
            />
            <label htmlFor="isActive" className="text-sm font-medium text-gray-700">Active</label>
          </div>
        </div>

        <div className="border-t pt-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-800">Questions</h3>
            <button
              onClick={addQuestion}
              className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 transition-colors"
            >
              Add Question
            </button>
          </div>

          <div className="space-y-3">
            {formData.questions.map((question, index) => (
              <div key={question.id} className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-start justify-between mb-3">
                  <span className="text-sm font-medium text-gray-600">Question {index + 1}</span>
                  <button
                    onClick={() => removeQuestion(index)}
                    className="text-red-500 hover:text-red-700"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                <div className="space-y-3">
                  <input
                    type="text"
                    value={question.question}
                    onChange={(e) => updateQuestion(index, { question: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                    placeholder="Enter your question"
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <select
                      value={question.type}
                      onChange={(e) => updateQuestion(index, { type: e.target.value as QuestionType })}
                      className="px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="select">Select</option>
                      <option value="multiselect">Multi-select</option>
                      <option value="radio">Radio</option>
                      <option value="checkbox">Checkbox</option>
                      <option value="date">Date</option>
                    </select>

                    <label className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={question.required}
                        onChange={(e) => updateQuestion(index, { required: e.target.checked })}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm">Required</span>
                    </label>
                  </div>

                  {(question.type === 'select' || question.type === 'multiselect' || question.type === 'radio' || question.type === 'checkbox') && (
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Options (one per line)</label>
                      <textarea
                        value={question.options?.join('\n') || ''}
                        onChange={(e) => updateQuestion(index, { options: e.target.value.split('\n').filter(o => o.trim()) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        rows={3}
                        placeholder="Option 1&#10;Option 2&#10;Option 3"
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-gray-100">
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-gray-100 text-gray-700 font-medium py-2.5 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="flex-1 bg-blue-600 text-white font-medium py-2.5 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
          >
            <Save size={16} />
            {loading ? 'Saving...' : 'Save Questionnaire'}
          </button>
        </div>
      </div>
    </div>
  );
};