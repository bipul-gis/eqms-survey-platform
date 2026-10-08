import type { Question } from '../types';
import { repeatGroupMemberIds } from './repeatedQuestions';

/**
 * Keep the UDD household income earner fields derived from member repeats:
 * positive member income counts only when that same member's sex matches.
 */
export const configureHouseholdIncomeEarnerCounts = (questions: Question[]): Question[] => {
  const memberIds = new Set<string>();
  let repeatGroupConfigured = false;
  for (let sectionIndex = 0; sectionIndex < questions.length; sectionIndex += 1) {
    const section = questions[sectionIndex];
    if (section.type !== 'section' || !section.repeatSection?.countQuestionId) continue;
    repeatGroupConfigured = true;
    repeatGroupMemberIds(questions, sectionIndex).forEach((id) => memberIds.add(id));
  }
  // The generated UDD questionnaire has the correct repeat block ordering,
  // but older saved questionnaire revisions may lack repeatSection metadata.
  // Infer that specific block from the stable UDD member field IDs.
  if (!repeatGroupConfigured) {
    const sexIndex = questions.findIndex((question) => question.id === 'member_sex');
    const incomeIndex = questions.findIndex((question) => question.id === 'member_monthly_income');
    if (sexIndex >= 0 && incomeIndex > sexIndex) {
      questions.slice(sexIndex, incomeIndex + 1).forEach((question) => memberIds.add(question.id));
    }
  }
  const sexQuestion = questions.find((question) =>
    memberIds.has(question.id) && /^(sex|gender)$/i.test(question.question.trim())
  );
  const incomeQuestion = questions.find((question) =>
    memberIds.has(question.id) && /monthly\s+income/i.test(question.question)
  );
  const sexQuestionId = sexQuestion?.id ?? (memberIds.has('member_sex') ? 'member_sex' : undefined);
  const incomeQuestionId = incomeQuestion?.id ?? (memberIds.has('member_monthly_income') ? 'member_monthly_income' : undefined);
  if (!sexQuestionId || !incomeQuestionId) return questions;

  const match = new Map<string, string>([
    ['income_earners_male', 'male'],
    ['income_earners_female', 'female']
  ]);
  return questions.map((question) => {
    const value = match.get(question.id);
    if (!value) return question;
    return {
      ...question,
      type: 'computed',
      required: false,
      computed: {
        operation: 'count_repeat_nonzero_matching',
        operandQuestionIds: [incomeQuestionId],
        repeatMatchQuestionId: sexQuestionId,
        repeatMatchValue: value,
        decimals: 0
      }
    };
  });
};
