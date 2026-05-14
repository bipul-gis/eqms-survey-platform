import React from 'react';
import { QuestionOption } from '../types';
import {
  isOtherSpecifyAnswer,
  OTHER_OPTION_VALUE
} from '../lib/choiceAnswers';

export interface ChoiceWithOtherFieldsProps {
  mode: 'select' | 'radio';
  /** `name` attribute for radio inputs (group id). */
  name: string;
  options: QuestionOption[];
  allowOther?: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  className: string;
  /**
   * When it returns true for an option `value`, that choice is greyed out
   * and cannot be selected.
   */
  getOptionDisabled?: (optionValue: string) => boolean;
}

/**
 * Renders a `<select>` or radio group plus optional "Other (please specify)"
 * free-text field when `allowOther` is true. Value is either the option
 * `value` string or `{ other: true, text: string }`.
 */
export const ChoiceWithOtherFields: React.FC<ChoiceWithOtherFieldsProps> = ({
  mode,
  name,
  options,
  allowOther,
  value,
  onChange,
  className,
  getOptionDisabled
}) => {
  const isOther = isOtherSpecifyAnswer(value);
  const selectedValue = isOther ? OTHER_OPTION_VALUE : ((value as string) || '');
  const otherText = isOther ? value.text : '';

  React.useEffect(() => {
    if (!getOptionDisabled) return;
    if (mode === 'select') {
      if (
        selectedValue &&
        selectedValue !== OTHER_OPTION_VALUE &&
        getOptionDisabled(selectedValue)
      ) {
        onChange('');
      }
      return;
    }
    if (!isOther && typeof value === 'string' && value && getOptionDisabled(value)) {
      onChange('');
    }
  }, [mode, selectedValue, value, isOther, getOptionDisabled, onChange]);

  if (mode === 'select') {
    return (
      <div className="space-y-2">
        <select
          value={selectedValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === OTHER_OPTION_VALUE) {
              onChange({ other: true, text: otherText });
            } else {
              onChange(v);
            }
          }}
          className={className}
        >
          <option value="">— select —</option>
          {options.map((o) => (
            <option
              key={o.id}
              value={o.value}
              disabled={getOptionDisabled?.(o.value)}
              title={getOptionDisabled?.(o.value) ? 'Not available based on your previous answers' : undefined}
            >
              {o.label}
            </option>
          ))}
          {allowOther && (
            <option value={OTHER_OPTION_VALUE}>Other (please specify)</option>
          )}
        </select>
        {allowOther && selectedValue === OTHER_OPTION_VALUE && (
          <input
            type="text"
            className={className}
            value={otherText}
            placeholder="Please specify…"
            onChange={(e) => onChange({ other: true, text: e.target.value })}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {options.map((o) => {
          const dis = getOptionDisabled?.(o.value);
          return (
            <label
              key={o.id}
              className={`flex items-center gap-2 text-sm ${dis ? 'text-slate-400' : 'text-slate-700'}`}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                disabled={dis}
                title={
                  dis ? 'Not available based on your previous answers' : undefined
                }
                checked={!isOther && value === o.value}
                onChange={() => onChange(o.value)}
              />
              {o.label}
            </label>
          );
        })}
        {allowOther && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name={name}
              value={OTHER_OPTION_VALUE}
              checked={isOther}
              onChange={() => onChange({ other: true, text: otherText })}
            />
            Other (please specify)
          </label>
        )}
      </div>
      {allowOther && isOther && (
        <input
          type="text"
          className={className}
          value={otherText}
          placeholder="Please specify…"
          onChange={(e) => onChange({ other: true, text: e.target.value })}
        />
      )}
    </div>
  );
};
