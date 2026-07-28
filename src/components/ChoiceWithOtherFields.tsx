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
  /** When Other is selected, show required cue on the specify field. */
  otherRequired?: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  className: string;
  /**
   * When it returns true for an option `value`, that choice is greyed out
   * and cannot be selected.
   */
  getOptionDisabled?: (optionValue: string) => boolean;
  /**
   * When it returns true for an option `value`, that choice is omitted from
   * the list (and any current selection of it is cleared).
   */
  getOptionHidden?: (optionValue: string) => boolean;
  /** Disable the synthetic Other option (same UX as option disable rules). */
  otherDisabled?: boolean;
  /** Hide the synthetic Other option entirely. */
  otherHidden?: boolean;
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
  otherRequired,
  value,
  onChange,
  className,
  getOptionDisabled,
  getOptionHidden,
  otherDisabled = false,
  otherHidden = false
}) => {
  const isOther = isOtherSpecifyAnswer(value);
  const selectedValue = isOther ? OTHER_OPTION_VALUE : ((value as string) || '');
  const otherText = isOther ? value.text : '';
  const visibleOptions = options.filter((o) => !getOptionHidden?.(o.value));
  const showOther = !!(allowOther && !otherHidden);

  React.useEffect(() => {
    const unavailable = (optValue: string) =>
      !!getOptionHidden?.(optValue) || !!getOptionDisabled?.(optValue);

    if (isOther && (otherHidden || otherDisabled)) {
      onChange('');
      return;
    }

    if (mode === 'select') {
      if (
        selectedValue &&
        selectedValue !== OTHER_OPTION_VALUE &&
        unavailable(selectedValue)
      ) {
        onChange('');
      }
      return;
    }
    if (!isOther && typeof value === 'string' && value && unavailable(value)) {
      onChange('');
    }
  }, [
    mode,
    selectedValue,
    value,
    isOther,
    getOptionDisabled,
    getOptionHidden,
    otherDisabled,
    otherHidden,
    onChange
  ]);

  const otherSpecifyInput =
    showOther && isOther ? (
      <input
        type="text"
        className={className}
        value={otherText}
        placeholder={
          otherRequired ? 'Please specify… (required)' : 'Please specify…'
        }
        required={!!otherRequired}
        aria-required={otherRequired ? true : undefined}
        onChange={(e) => onChange({ other: true, text: e.target.value })}
      />
    ) : null;

  if (mode === 'select') {
    return (
      <div className="space-y-2">
        <select
          value={selectedValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === OTHER_OPTION_VALUE) {
              if (otherDisabled) return;
              onChange({ other: true, text: otherText });
            } else {
              onChange(v);
            }
          }}
          className={className}
        >
          <option value="">— select —</option>
          {visibleOptions.map((o) => (
            <option
              key={o.id}
              value={o.value}
              disabled={getOptionDisabled?.(o.value)}
              title={
                getOptionDisabled?.(o.value)
                  ? 'Not available based on your previous answers'
                  : undefined
              }
            >
              {o.label}
            </option>
          ))}
          {showOther && (
            <option value={OTHER_OPTION_VALUE} disabled={otherDisabled}>
              Other (please specify)
              {otherRequired ? ' *' : ''}
            </option>
          )}
        </select>
        {otherSpecifyInput}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {visibleOptions.map((o) => {
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
        {showOther && (
          <label
            className={`flex items-center gap-2 text-sm ${
              otherDisabled ? 'text-slate-400' : 'text-slate-700'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={OTHER_OPTION_VALUE}
              disabled={otherDisabled}
              checked={isOther}
              onChange={() => {
                if (otherDisabled) return;
                onChange({ other: true, text: otherText });
              }}
            />
            Other (please specify)
            {otherRequired ? (
              <span className="text-red-500 font-semibold" title="Specify text required">
                *
              </span>
            ) : null}
          </label>
        )}
      </div>
      {otherSpecifyInput}
    </div>
  );
};
