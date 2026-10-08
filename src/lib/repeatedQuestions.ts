import type { Question } from '../types';

const MAX_SECTION_REPEATS = 100;
const repeatedId = (id: string, index: number) => `${id}__repeat_${index}`;

export const isRepeatCountQuestionCandidate = (question: Question): boolean =>
  ['number', 'scale', 'rating', 'computed', 'text', 'select', 'radio'].includes(question.type);

export const repeatGroupMemberIds = (questions: Question[], sectionIndex: number): string[] => {
  const section = questions[sectionIndex];
  if (!section || section.type !== 'section' || !section.repeatSection) return [];
  if (section.repeatSection.questionIds) return section.repeatSection.questionIds;
  let end = sectionIndex + 1;
  while (end < questions.length && questions[end].type !== 'section') end += 1;
  return questions.slice(sectionIndex + 1, end).filter((question) => question.type !== 'section').map((question) => question.id);
};

export const getRepeatedQuestionSourceIds = (questions: Question[]): Set<string> => {
  const ids = new Set<string>();
  for (let index = 0; index < questions.length; index += 1) {
    if (questions[index].type !== 'section' || !questions[index].repeatSection?.countQuestionId) continue;
    ids.add(questions[index].id);
    for (const id of repeatGroupMemberIds(questions, index)) ids.add(id);
  }
  return ids;
};

/** Expand repeat-enabled section blocks into independent runtime question IDs. */
export const expandRepeatedQuestions = (
  questions: Question[],
  answers: Record<string, unknown>
): Question[] => {
  const expanded: Question[] = [];
  const memberToSection = new Map<string, string>();
  for (let index = 0; index < questions.length; index += 1) {
    const section = questions[index];
    if (section.type !== 'section' || !section.repeatSection?.countQuestionId) continue;
    for (const id of repeatGroupMemberIds(questions, index)) {
      if (!memberToSection.has(id)) memberToSection.set(id, section.id);
    }
  }
  for (let index = 0; index < questions.length;) {
    const start = questions[index];
    if (start.type !== 'section' || !start.repeatSection?.countQuestionId) {
      if (!memberToSection.has(start.id)) expanded.push(start);
      index += 1;
      continue;
    }

    const memberIds = new Set(repeatGroupMemberIds(questions, index));
    if (start.repeatSection.questionIds && memberIds.size === 0) {
      expanded.push(start);
      index += 1;
      continue;
    }
    const members = questions.filter((candidate) => memberIds.has(candidate.id));
    const block = [start, ...members];
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
    index += 1;
  }
  return expanded;
};
