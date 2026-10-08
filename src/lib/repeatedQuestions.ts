import type { Question } from '../types';

const MAX_SECTION_REPEATS = 100;
const repeatedId = (id: string, index: number) => `${id}__repeat_${index}`;

export const isRepeatCountQuestionCandidate = (question: Question): boolean =>
  ['number', 'scale', 'rating', 'computed', 'text', 'select', 'radio'].includes(question.type);

export const getRepeatedQuestionSourceIds = (questions: Question[]): Set<string> => {
  const ids = new Set<string>();
  for (let index = 0; index < questions.length; index += 1) {
    if (questions[index].type !== 'section' || !questions[index].repeatSection?.countQuestionId) continue;
    let end = index + 1;
    while (end < questions.length && questions[end].type !== 'section') end += 1;
    for (const question of questions.slice(index, end)) ids.add(question.id);
    index = end - 1;
  }
  return ids;
};

/** Expand repeat-enabled section blocks into independent runtime question IDs. */
export const expandRepeatedQuestions = (
  questions: Question[],
  answers: Record<string, unknown>
): Question[] => {
  const expanded: Question[] = [];
  for (let index = 0; index < questions.length;) {
    const start = questions[index];
    if (start.type !== 'section' || !start.repeatSection?.countQuestionId) {
      expanded.push(start);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < questions.length && questions[end].type !== 'section') end += 1;
    const block = questions.slice(index, end);
    const rawCount = answers[start.repeatSection.countQuestionId];
    const countValue = typeof rawCount === 'string' ? Number(rawCount.trim()) : Number(rawCount);
    const count = Number.isFinite(countValue)
      ? Math.max(0, Math.min(MAX_SECTION_REPEATS, Math.floor(countValue)))
      : 0;
    const blockIds = new Set(block.map((question) => question.id));

    for (let iteration = 1; iteration <= count; iteration += 1) {
      for (const question of block) {
        const id = repeatedId(question.id, iteration);
        const remapQuestionId = (questionId: string) =>
          blockIds.has(questionId) ? repeatedId(questionId, iteration) : questionId;
        const clone = JSON.parse(JSON.stringify(question)) as Question;
        clone.id = id;
        clone.repeatSourceId = question.id;
        clone.repeatIndex = iteration;
        if (clone.parentId) clone.parentId = remapQuestionId(clone.parentId);
        const remapReferences = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(remapReferences);
          if (!value || typeof value !== 'object') return value;
          return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
            key,
            key === 'questionId' && typeof entry === 'string'
              ? remapQuestionId(entry)
              : remapReferences(entry)
          ]));
        };
        if (clone.logic) clone.logic = remapReferences(clone.logic) as Question['logic'];
        if (clone.defaultValueRules) clone.defaultValueRules = remapReferences(clone.defaultValueRules) as Question['defaultValueRules'];
        if (clone.options) clone.options = remapReferences(clone.options) as Question['options'];
        if (clone.otherDisabledWhen) clone.otherDisabledWhen = remapReferences(clone.otherDisabledWhen) as Question['otherDisabledWhen'];
        if (clone.otherHiddenWhen) clone.otherHiddenWhen = remapReferences(clone.otherHiddenWhen) as Question['otherHiddenWhen'];
        if (clone.otherAvailableWhen) clone.otherAvailableWhen = remapReferences(clone.otherAvailableWhen) as Question['otherAvailableWhen'];
        if (clone.computed) {
          clone.computed = {
            ...clone.computed,
            operandQuestionIds: clone.computed.operandQuestionIds?.map(remapQuestionId),
            expression: clone.computed.expression?.replace(/\{\{([^}]+)\}\}/g, (match, token: string) => {
              const referenced = block.find((candidate) => candidate.id === token || candidate.key === token);
              return referenced ? `{{${remapQuestionId(referenced.id)}}}` : match;
            })
          };
        }
        if (question.type === 'section') {
          clone.question = `${question.question} (${iteration})`;
          clone.repeatSection = undefined;
        }
        expanded.push(clone);
      }
    }
    index = end;
  }
  return expanded;
};
