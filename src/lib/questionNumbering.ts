import type { Question } from '../types';

export interface QuestionNumbering {
  /** Section number for section break questions. */
  sectionNumbers: Map<string, number>;
  /** Stable visible number for every survey question. */
  questionNumbers: Map<string, string>;
  /** Explicit or logic-derived parent question for nested numbering. */
  parentIds: Map<string, string>;
}

export interface NumberedQuestionSlot {
  question: Question;
  label: string;
  depth: number;
}

/**
 * Number questions by section (1.1, 1.2), with child or logic-gated questions
 * nested beneath their controlling question (1.1.a, 1.1.b). Numbers use the
 * complete form definition, so they stay stable when a branch is hidden.
 */
export const buildQuestionNumbering = (questions: Question[]): QuestionNumbering => {
  const sectionNumbers = new Map<string, number>();
  const questionNumbers = new Map<string, string>();
  const sectionForQuestion = new Map<string, number>();
  const byId = new Map(questions.map((question) => [question.id, question]));

  let currentSection = 1;
  let hasContentBeforeFirstSection = false;
  let sawSection = false;
  for (const question of questions) {
    if (question.type === 'section') {
      if (sawSection || hasContentBeforeFirstSection) currentSection += 1;
      sawSection = true;
      sectionNumbers.set(question.id, currentSection);
      sectionForQuestion.set(question.id, currentSection);
      continue;
    }
    if (!sawSection) hasContentBeforeFirstSection = true;
    sectionForQuestion.set(question.id, currentSection);
  }

  const parentIds = new Map<string, string>();
  for (const question of questions) {
    if (question.type === 'section') continue;
    const candidateId =
      question.parentId ||
      (question.logic?.enabled && question.logic.conditions.length > 0
        ? question.logic.conditions[0].questionId
        : undefined);
    if (!candidateId || candidateId === question.id) continue;
    const parent = byId.get(candidateId);
    if (!parent || parent.type === 'section') continue;
    if (sectionForQuestion.get(parent.id) !== sectionForQuestion.get(question.id)) continue;
    parentIds.set(question.id, parent.id);
  }

  const children = new Map<string, Question[]>();
  for (const question of questions) {
    const parentId = parentIds.get(question.id);
    if (!parentId) continue;
    const siblings = children.get(parentId) || [];
    siblings.push(question);
    children.set(parentId, siblings);
  }

  const questionCounts = new Map<number, number>();
  const numbered = new Set<string>();
  const assignChildren = (parent: Question, parentNumber: string, visited: Set<string>) => {
    if (visited.has(parent.id)) return;
    const nextVisited = new Set(visited).add(parent.id);
    (children.get(parent.id) || []).forEach((child, index) => {
      const number = `${parentNumber}.${String.fromCharCode(97 + index)}`;
      questionNumbers.set(child.id, number);
      numbered.add(child.id);
      assignChildren(child, number, nextVisited);
    });
  };

  for (const question of questions) {
    if (question.type === 'section' || parentIds.has(question.id) || numbered.has(question.id)) continue;
    const section = sectionForQuestion.get(question.id) || 1;
    const nextQuestion = (questionCounts.get(section) || 0) + 1;
    questionCounts.set(section, nextQuestion);
    const number = `${section}.${nextQuestion}`;
    questionNumbers.set(question.id, number);
    numbered.add(question.id);
    assignChildren(question, number, new Set());
  }

  // Malformed legacy cycles should still receive a stable number.
  for (const question of questions) {
    if (question.type === 'section' || numbered.has(question.id)) continue;
    const section = sectionForQuestion.get(question.id) || 1;
    const nextQuestion = (questionCounts.get(section) || 0) + 1;
    questionCounts.set(section, nextQuestion);
    questionNumbers.set(question.id, `${section}.${nextQuestion}`);
  }

  return { sectionNumbers, questionNumbers, parentIds };
};

/** Render visible logic/explicit children immediately after their parent. */
export const buildVisibleQuestionSlots = (
  visibleQuestions: Question[],
  numbering: QuestionNumbering
): NumberedQuestionSlot[] => {
  const visibleIds = new Set(visibleQuestions.map((question) => question.id));
  const slots: NumberedQuestionSlot[] = [];
  const placed = new Set<string>();

  const append = (question: Question, depth: number) => {
    if (placed.has(question.id)) return;
    placed.add(question.id);
    const label = question.type === 'section'
      ? String(numbering.sectionNumbers.get(question.id) ?? '')
      : numbering.questionNumbers.get(question.id) || '';
    slots.push({ question, label, depth });
    for (const child of visibleQuestions) {
      if (numbering.parentIds.get(child.id) === question.id) append(child, depth + 1);
    }
  };

  for (const question of visibleQuestions) {
    const parentId = numbering.parentIds.get(question.id);
    if (!parentId || !visibleIds.has(parentId)) append(question, 0);
  }
  for (const question of visibleQuestions) append(question, 0);

  return slots;
};
