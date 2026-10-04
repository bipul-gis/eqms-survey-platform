import source from './uddSurveyQuestionnaire.generated.json';
import type { Question, Questionnaire } from '../types';

const questions = source.questions as unknown as Question[];

export const shouldSeedUddQuestionnaireForProject = (
  projectId?: string,
  projectName?: string
): boolean => {
  if (!projectId || !projectName) return false;
  const haystack = `${projectId} ${projectName}`.toLowerCase();
  return /upazila|twelve|12.*upazila|socio[- ]economic|comprehensive development plan|udd|ulb/i.test(haystack);
};

export const uddSocioEconomicQuestionnaireTemplate = (
  projectId: string,
  projectName?: string
): Questionnaire => ({
  id: 'udd_12_upazila_socioeconomic_survey',
  projectId,
  title: 'Pre-test Final UDD Socioeconomic Survey',
  description:
    'Questionnaire imported from the UDD XLSForm workbook. English and Bangla labels and choices are stored separately.',
  version: '2.2',
  questions: structuredClone(questions),
  sections: [],
  settings: {
    showProgress: true,
    allowSaveDraft: true,
    paginated: false,
    captureLocation: true,
    shuffleQuestions: false,
  },
  isActive: true,
  createdBy: 'system',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});