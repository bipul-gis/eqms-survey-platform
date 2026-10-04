import type { Question, QuestionnaireSection } from '../types';

export const normalizeQuestionnaireSectionQuestions = (
  questions: Question[],
  sections: QuestionnaireSection[] = []
): Question[] => {
  if (questions.length === 0 || sections.length === 0) return questions;

  const sectionsById = new Map(sections.map((section) => [section.id, section]));
  const insertedSectionIds = new Set<string>();
  const normalized: Question[] = [];

  for (const question of questions) {
    if (question.type === 'section') {
      insertedSectionIds.add(question.id);
      normalized.push(question);
      continue;
    }

    const section = question.sectionId ? sectionsById.get(question.sectionId) : undefined;
    if (!section) {
      normalized.push(question);
      continue;
    }

    if (!insertedSectionIds.has(section.id)) {
      normalized.push({
        id: section.id,
        type: 'section',
        question: section.title,
        description: section.description,
        required: false
      });
      insertedSectionIds.add(section.id);
    }

    const { sectionId: _sectionId, ...withoutSectionId } = question;
    void _sectionId;
    normalized.push(withoutSectionId);
  }

  return normalized;
};