import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResponsesCsvFromTable,
  buildResponsesShpFieldMapping,
  buildResponsesTable
} from '../src/lib/responseExport';
import type { Questionnaire, QuestionnaireResponse } from '../src/types';

const questionnaire = {
  id: 'q1',
  title: 'Field survey',
  description: '',
  version: '1',
  isActive: true,
  createdBy: 'admin',
  createdAt: '',
  updatedAt: '',
  consentGate: { enabled: true },
  enumeratorInfo: { fields: [{ id: 'enum_name', key: 'name', type: 'text', question: 'Enumerator name' }] },
  questions: [
    { id: 'matrix1', key: 'grid', type: 'matrix', question: 'Services', required: false, rows: ['Water'] },
    { id: 'known', key: 'known', type: 'text', question: 'Known field', required: false }
  ]
} as unknown as Questionnaire;

const response = {
  id: 'r1',
  questionnaireId: 'q1',
  respondentId: 'u1',
  respondentName: 'Enumerator',
  status: 'submitted',
  responses: {
    matrix1: { Water: 'Available', 'Legacy row': 'Unavailable' },
    known: 'A long answer, with "quotes" and বাংলা text',
    deletedQuestion: 'Preserve this removed question answer'
  },
  enumeratorInfo: { enum_name: 'Enumerator A' }
} as unknown as QuestionnaireResponse;

test('CSV keeps all defined fields, removed answers, and legacy matrix rows', () => {
  const table = buildResponsesTable(questionnaire, [response]);
  assert.ok(table.header.includes('Info: Enumerator name'));
  assert.ok(table.header.some((header) => header.endsWith('Services — Water')));
  assert.ok(table.header.some((header) => header.endsWith('Services — Legacy row')));
  assert.ok(table.header.includes('deletedQuestion (removed from questionnaire)'));
  assert.equal(table.header.length, table.rows[0].length);
  assert.ok(buildResponsesCsvFromTable(table).includes('A long answer, with ""quotes"" and বাংলা text'));
});

test('CSV includes map-feature fields stored beside the questionnaire answers', () => {
  const table = buildResponsesTable(questionnaire, [
    {
      ...response,
      responses: {
        ...response.responses,
        'linked_attribute:Dia_cm': 42,
        'linked_attribute:Local_Name': 'Shimul'
      },
      linkedFeatureProperties: { Height_m: 12.5, Dia_cm: 42 }
    } as unknown as QuestionnaireResponse
  ]);
  assert.ok(table.header.includes('Dia_cm'));
  assert.ok(table.header.includes('Local_Name'));
  assert.ok(table.header.includes('Height_m'));
  const row = table.rows[0];
  assert.equal(row[table.header.indexOf('Dia_cm')], '42');
  assert.equal(row[table.header.indexOf('Local_Name')], 'Shimul');
  assert.equal(row[table.header.indexOf('Height_m')], '12.5');
});

test('SHP mapping gives every export field a unique DBF field name', () => {
  const mapping = buildResponsesShpFieldMapping(questionnaire, [response]);
  assert.equal(mapping.length, buildResponsesTable(questionnaire, [response]).header.length);
  assert.equal(new Set(mapping.map((field) => field.shpDbfField)).size, mapping.length);
  assert.ok(mapping.every((field) => /^[A-Z0-9_]{1,8}$/.test(field.shpDbfField)));
  assert.ok(mapping.some((field) => field.csvHeader.endsWith('Services — Legacy row')));
});
