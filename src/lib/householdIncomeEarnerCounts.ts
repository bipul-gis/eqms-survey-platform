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
  // Locate the household member repeat block specifically. Other questionnaire
  // repeat sections must not suppress the legacy household fallback.
  const instructionIndex = questions.findIndex((question) =>
      question.type === 'section' && /repeat record for each household member/i.test(
        `${question.question} ${question.description ?? ''} ${question.questionTranslations?.en ?? ''} ${question.descriptionTranslations?.en ?? ''}`
      )
  );
  if (instructionIndex >= 0) {
    for (let index = instructionIndex + 1; index < questions.length && questions[index].type !== 'section'; index += 1) {
      memberIds.add(questions[index].id);
    }
  }
  // Some saved copies include the stable member fields without the
  // instructional section metadata.
  const sexIndex = questions.findIndex((question) => question.id === 'member_sex');
  const incomeIndex = questions.findIndex((question) => question.id === 'member_monthly_income');
  if (sexIndex >= 0 && incomeIndex > sexIndex) {
    questions.slice(sexIndex, incomeIndex + 1).forEach((question) => memberIds.add(question.id));
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
      validation: { ...question.validation, integerOnly: true, min: 0 },
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
