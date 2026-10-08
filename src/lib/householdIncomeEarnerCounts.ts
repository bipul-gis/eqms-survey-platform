import type { Question } from '../types';
import { repeatGroupMemberIds } from './repeatedQuestions';

/**
 * Keep the UDD household income earner fields derived from member repeats:
 * positive member income counts only when that same member's sex matches.
 */
export const configureHouseholdIncomeEarnerCounts = (questions: Question[]): Question[] => {
  const memberIds = new Set<string>();
  for (let sectionIndex = 0; sectionIndex < questions.length; sectionIndex += 1) {
    const section = questions[sectionIndex];
    if (section.type !== 'section' || !section.repeatSection?.countQuestionId) continue;
    repeatGroupMemberIds(questions, sectionIndex).forEach((id) => memberIds.add(id));
  }
  if (!memberIds.has('member_sex') || !memberIds.has('member_monthly_income')) return questions;

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
        operandQuestionIds: ['member_monthly_income'],
        repeatMatchQuestionId: 'member_sex',
        repeatMatchValue: value,
        decimals: 0
      }
    };
  });
};
