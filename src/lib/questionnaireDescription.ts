/** Import-only text that should not be presented as respondent instructions. */
export const UDD_XLSFORM_IMPORT_DESCRIPTION =
  'Questionnaire imported from the UDD XLSForm workbook. English and Bangla labels and choices are stored separately.';

export const isUddXlsformImportDescription = (value: unknown): boolean =>
  typeof value === 'string' &&
  value.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ===
    UDD_XLSFORM_IMPORT_DESCRIPTION.toLocaleLowerCase();
