/**
 * QuestionnaireRuntime — runtime renderers shared between the admin preview
 * (inside `QuestionnaireManager.PreviewDialog`) and the real enumerator
 * `QuestionnaireForm`. These components don't know anything about builder
 * state; they take a configuration object + current answers and render the
 * user-facing UI.
 *
 * Kept in its own file so the enumerator-side bundle doesn't need to pull in
 * the much larger `QuestionnaireManager` chunk (drag-and-drop, logic editor,
 * publish controls, etc.) just to render a survey.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Crosshair,
  IdCard,
  Loader2,
  Locate,
  Lock,
  Satellite,
  ShieldCheck,
  Sigma,
  Star
} from 'lucide-react';
import {
  ComputedSpec,
  ConsentGate,
  DescriptionBlock,
  DefaultValueRule,
  EnumeratorInfo,
  GpsCaptureSettings,
  LogicRule,
  Question,
  QuestionOption,
  ValueRuleMode
} from '../types';
import { evaluateComputed } from '../lib/computedAnswers';
import { formatConsentGateTemplate } from '../lib/consentGateTemplate';
import {
  choiceAnswerIsEmpty as choiceAnswerIsLogicallyEmpty,
  choiceAnswerToComparableString
} from '../lib/choiceAnswers';
import { ChoiceWithOtherFields } from './ChoiceWithOtherFields';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read-only chip shown for `computed` questions in the live runtime.
 * Enumerators can see the live result but cannot edit it — the field
 * is non-interactive and styled distinctly so they know to look
 * upstream when the cell is empty.
 */
const ComputedAnswerCell: React.FC<{
  display: string;
  spec?: ComputedSpec;
}> = ({ display, spec }) => {
  const hasValue = display !== '';
  return (
    <div className="flex flex-col gap-1">
      <div
        className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${
          hasValue
            ? 'border-violet-200 bg-violet-50 text-violet-900'
            : 'border-dashed border-slate-300 bg-slate-50 text-slate-400 italic'
        }`}
        aria-readonly="true"
      >
        <span className="text-sm font-mono break-all min-w-0">
          {hasValue ? display : 'Waiting for operand answers…'}
        </span>
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-violet-700 bg-white border border-violet-200 rounded-full px-1.5 py-0.5 shrink-0">
          <Sigma size={10} /> Auto
        </span>
      </div>
      {spec?.operation && (
        <p className="text-[10px] text-slate-400">
          Auto-calculated from other answers. You can&rsquo;t edit this field directly.
        </p>
      )}
    </div>
  );
};

/**
 * Some legacy questionnaires still store `Question.options` as plain string
 * arrays. The new builder writes `QuestionOption[]` objects. Normalize so
 * rendering never crashes with "Objects are not valid as a React child".
 */
export const ensureOptionShape = (opts: Question['options']): QuestionOption[] => {
  if (!opts || opts.length === 0) return [];
  if (typeof opts[0] === 'string') {
    return (opts as string[]).map((s, i) => ({ id: `opt_${i}`, value: s, label: s }));
  }
  return opts as QuestionOption[];
};

/** Evaluate a question's visibility rule against the current answer map. */
export const evaluateLogic = (
  logic: LogicRule | undefined,
  answers: Record<string, unknown>
): boolean => {
  if (!logic || !logic.enabled || logic.conditions.length === 0) return true;
  const results = logic.conditions.map((c) => {
    const a = answers[c.questionId];
    const v = c.value ?? '';
    switch (c.operator) {
      case 'equals':
        return choiceAnswerToComparableString(a) === String(v);
      case 'notEquals':
        return choiceAnswerToComparableString(a) !== String(v);
      case 'contains':
        if (Array.isArray(a)) return a.includes(v);
        return choiceAnswerToComparableString(a)
          .toLowerCase()
          .includes(String(v).toLowerCase());
      case 'notContains':
        if (Array.isArray(a)) return !a.includes(v);
        return !choiceAnswerToComparableString(a)
          .toLowerCase()
          .includes(String(v).toLowerCase());
      case 'greaterThan':
        return Number(a) > Number(v);
      case 'lessThan':
        return Number(a) < Number(v);
      case 'isEmpty':
        return choiceAnswerIsLogicallyEmpty(a);
      case 'isNotEmpty':
        return !choiceAnswerIsLogicallyEmpty(a);
      default:
        return true;
    }
  });
  return logic.combinator === 'AND' ? results.every(Boolean) : results.some(Boolean);
};

/** True when this choice option should be greyed out / unselectable. */
export const isChoiceOptionDisabled = (
  option: QuestionOption,
  answers: Record<string, unknown>
): boolean => {
  const w = option.disabledWhen;
  if (!w?.enabled || !w.conditions?.length) return false;
  return evaluateLogic(w, answers);
};

// ---------------------------------------------------------------------------
// Default-value rules — auto-fill or lock answers based on other answers.
// Pure helpers, used by both the admin preview and the live form.
// ---------------------------------------------------------------------------

/**
 * Coerce a stored rule string into the value shape the target question
 * expects (number for `number`, array for multi-choice, string otherwise).
 * Keeping the rule value as a single serialized string in the data model
 * keeps the builder UI simple; coercion happens here at apply time.
 */
const coerceRuleValue = (raw: string, target: Question): unknown => {
  switch (target.type) {
    case 'number':
      // Empty string stays empty (so "lock to nothing" still works as a
      // legitimate clear); otherwise parse — fall back to the raw string
      // if the admin somehow stored a non-numeric default.
      if (raw === '') return '';
      return Number.isFinite(Number(raw)) ? Number(raw) : raw;
    case 'age': {
      // Accept "Y", "Y,M" or "Y M" for an age default — `0,6` means six
      // months old, `5` means exactly 5y/0m. Anything past `,` after the
      // first two slots is ignored.
      if (!raw.trim()) return '';
      const parts = raw.split(/[,\s/]+/).filter(Boolean);
      const y = Number(parts[0] ?? 0);
      const m = Number(parts[1] ?? 0);
      const yy = Number.isFinite(y) ? Math.max(0, Math.floor(y)) : 0;
      const mm = Number.isFinite(m) ? Math.min(11, Math.max(0, Math.floor(m))) : 0;
      return { years: yy, months: mm, totalMonths: yy * 12 + mm };
    }
    case 'checkbox':
    case 'multiselect':
      // Comma-separated → array of option values. Trim each and drop
      // empties so trailing commas don't introduce blank entries.
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    case 'date':
    case 'time':
    case 'datetime':
      return raw; // ISO-ish strings are passed through verbatim
    default:
      return raw;
  }
};

/** True when an answer should be considered "empty" for `fillIfEmpty` purposes. */
const isAnswerEmpty = (v: unknown): boolean => choiceAnswerIsLogicallyEmpty(v);

export interface AppliedDefaultRule {
  questionId: string;
  ruleId: string;
  mode: ValueRuleMode;
  /** Already coerced to the target question's expected value shape. */
  value: unknown;
}

/**
 * For each question, find the first matching `defaultValueRules` entry (if
 * any) and return what should happen. The form layer is responsible for
 * actually patching answers — this helper is pure so it can also be reused
 * by previews, validators, and tests.
 */
export const computeAppliedDefaultRules = (
  questions: Question[],
  answers: Record<string, unknown>
): AppliedDefaultRule[] => {
  const out: AppliedDefaultRule[] = [];
  for (const q of questions) {
    const rules = q.defaultValueRules;
    if (!rules || rules.length === 0) continue;
    for (const rule of rules) {
      // A rule with no enabled `when` would fire every render — that's
      // almost certainly a misconfiguration. Skip silently rather than
      // surprise enumerators.
      if (!rule.when?.enabled || rule.when.conditions.length === 0) continue;
      if (evaluateLogic(rule.when, answers)) {
        out.push({
          questionId: q.id,
          ruleId: rule.id,
          mode: rule.mode,
          value: coerceRuleValue(rule.value ?? '', q)
        });
        break; // first match wins — admins layer rules in priority order
      }
    }
  }
  return out;
};

/**
 * Equality check used to decide whether a rule needs to actually patch
 * the current answer. Matches Firestore-friendly value shapes (primitive
 * or array of primitives). Avoids needless setState that would fight the
 * enumerator's typing for `fillIfEmpty` rules with empty string values.
 */
export const ruleValueMatchesCurrent = (current: unknown, target: unknown): boolean => {
  if (Array.isArray(current) && Array.isArray(target)) {
    if (current.length !== target.length) return false;
    return current.every((v, i) => v === target[i]);
  }
  return (
    choiceAnswerToComparableString(current) === choiceAnswerToComparableString(target)
  );
};

// ---------------------------------------------------------------------------
// DescriptionRenderer — rich description blocks (headings/paragraphs/tables)
// ---------------------------------------------------------------------------

export const DescriptionRenderer: React.FC<{ blocks?: DescriptionBlock[] }> = ({ blocks }) => {
  if (!blocks || blocks.length === 0) return null;
  return (
    <div className="space-y-3">
      {blocks.map((b) => {
        if (b.type === 'heading') {
          const sizeClass =
            b.level === 1
              ? 'text-2xl font-bold text-slate-900'
              : b.level === 2
                ? 'text-xl font-bold text-slate-900'
                : 'text-base font-bold text-slate-800';
          return (
            <div key={b.id} className={sizeClass}>
              {b.text || <span className="text-slate-300 italic">(empty title)</span>}
            </div>
          );
        }
        if (b.type === 'paragraph') {
          return (
            <p key={b.id} className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
              {b.text}
            </p>
          );
        }
        const [header, ...body] = b.rows;
        return (
          <div key={b.id} className="overflow-x-auto">
            <table className="w-full text-sm border-collapse border border-slate-200 rounded">
              {header && (
                <thead className="bg-slate-50">
                  <tr>
                    {header.map((cell, ci) => (
                      <th
                        key={ci}
                        className="border border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-700"
                      >
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri} className="odd:bg-white even:bg-slate-50/40">
                    {row.map((cell, ci) => (
                      <td key={ci} className="border border-slate-200 px-3 py-2 text-slate-700">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// EnumeratorInfoTable — 2-column input table rendered above the survey
// ---------------------------------------------------------------------------

export const EnumeratorInfoTable: React.FC<{
  info: EnumeratorInfo;
  answers: Record<string, unknown>;
  /**
   * Answer map used to evaluate per-option `disabledWhen` rules. Defaults
   * to `answers` when omitted. Pass a merge of enumerator + survey answers so
   * enumerator choice options can reference main questionnaire fields.
   */
  logicAnswers?: Record<string, unknown>;
  onChange: (fieldId: string, value: unknown) => void;
}> = ({ info, answers, logicAnswers, onChange }) => {
  const cls =
    'w-full text-sm border border-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500';
  const logicCtx = logicAnswers ?? answers;

  const renderInput = (f: Question) => {
    const v = answers[f.id];
    const opts = ensureOptionShape(f.options);
    const getOptionDisabled = (optValue: string) => {
      const o = opts.find((x) => x.value === optValue);
      return o ? isChoiceOptionDisabled(o, logicCtx) : false;
    };
    switch (f.type) {
      case 'text':
      case 'email':
      case 'phone':
        return (
          <input
            type="text"
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            placeholder={f.placeholder}
            className={cls}
          />
        );
      case 'longtext':
        return (
          <textarea
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            placeholder={f.placeholder}
            rows={2}
            className={`${cls} resize-none`}
          />
        );
      case 'number':
        return (
          <input
            type="number"
            value={(v as string) ?? ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            className={cls}
          />
        );
      case 'age': {
        const ageVal = (v && typeof v === 'object' ? v : {}) as {
          years?: number | string;
          months?: number | string;
        };
        const yrs = ageVal.years === undefined ? '' : String(ageVal.years);
        const mos = ageVal.months === undefined ? '' : String(ageVal.months);
        const commit = (ny: string, nm: string) => {
          const y = ny === '' ? undefined : Math.max(0, Number(ny));
          const mRaw = nm === '' ? undefined : Math.max(0, Number(nm));
          const m = mRaw === undefined ? undefined : Math.min(11, mRaw);
          if (y === undefined && m === undefined) {
            onChange(f.id, undefined);
            return;
          }
          const yy = y ?? 0;
          const mm = m ?? 0;
          onChange(f.id, { years: yy, months: mm, totalMonths: yy * 12 + mm });
        };
        return (
          <div className="flex gap-2">
            <div className="flex-1 min-w-0 relative">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={150}
                step={1}
                value={yrs}
                onChange={(e) => commit(e.target.value, mos)}
                placeholder="0"
                className={`${cls} pr-12`}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Years
              </span>
            </div>
            <div className="flex-1 min-w-0 relative">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={11}
                step={1}
                value={mos}
                onChange={(e) => commit(yrs, e.target.value)}
                placeholder="0"
                className={`${cls} pr-14`}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Months
              </span>
            </div>
          </div>
        );
      }
      case 'date':
        return (
          <input
            type="date"
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            className={cls}
          />
        );
      case 'time':
        return (
          <input
            type="time"
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            className={cls}
          />
        );
      case 'datetime':
        return (
          <input
            type="datetime-local"
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            className={cls}
          />
        );
      case 'select':
        return (
          <ChoiceWithOtherFields
            mode="select"
            name={f.id}
            options={opts}
            allowOther={f.allowOther}
            value={v}
            onChange={(next) => onChange(f.id, next)}
            className={cls}
            getOptionDisabled={getOptionDisabled}
          />
        );
      case 'radio':
        return (
          <ChoiceWithOtherFields
            mode="radio"
            name={f.id}
            options={opts}
            allowOther={f.allowOther}
            value={v}
            onChange={(next) => onChange(f.id, next)}
            className={cls}
            getOptionDisabled={getOptionDisabled}
          />
        );
      case 'checkbox': {
        const arr = Array.isArray(v) ? (v as string[]) : [];
        return (
          <div className="flex flex-wrap gap-3">
            {opts.map((o) => (
              <label
                key={o.id}
                className={`flex items-center gap-1.5 text-xs ${
                  isChoiceOptionDisabled(o, logicCtx) ? 'text-slate-400' : 'text-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={isChoiceOptionDisabled(o, logicCtx)}
                  checked={arr.includes(o.value)}
                  onChange={(e) =>
                    onChange(
                      f.id,
                      e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value)
                    )
                  }
                />
                {o.label}
              </label>
            ))}
          </div>
        );
      }
      case 'multiselect':
        return (
          <select
            multiple
            value={(v as string[]) || []}
            onChange={(e) =>
              onChange(
                f.id,
                Array.from(
                  e.target.selectedOptions as HTMLCollectionOf<HTMLOptionElement>
                )
                  .map((o) => o.value)
                  .filter((pv) => {
                    const o = opts.find((x) => x.value === pv);
                    return !o || !isChoiceOptionDisabled(o, logicCtx);
                  })
              )
            }
            className={`${cls} h-24`}
          >
            {opts.map((o) => (
              <option key={o.id} value={o.value} disabled={isChoiceOptionDisabled(o, logicCtx)}>
                {o.label}
              </option>
            ))}
          </select>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-gradient-to-r from-indigo-50/40 to-blue-50/40 rounded-lg border border-indigo-100 overflow-hidden">
      <div className="px-4 py-2.5 bg-indigo-600 text-white flex items-center gap-2">
        <IdCard size={16} />
        <div>
          <div className="text-sm font-bold">{info.title || 'Enumerator Information'}</div>
          {info.description && (
            <div className="text-[11px] text-indigo-100/90">{info.description}</div>
          )}
        </div>
      </div>
      <table className="w-full text-sm border-collapse">
        <tbody>
          {info.fields.map((f) => (
            <tr key={f.id} className="border-t border-indigo-100/80 first:border-t-0">
              <th className="text-left text-xs font-semibold text-slate-700 align-middle bg-indigo-50/70 px-4 py-2 w-1/3 border-r border-indigo-100/80">
                {f.question || 'Untitled field'}
                {f.required && <span className="text-red-500 ml-1">*</span>}
              </th>
              <td className="px-4 py-2 align-middle bg-white">{renderInput(f)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ConsentGateForm — paragraph + permission checkbox
// ---------------------------------------------------------------------------

export const ConsentGateForm: React.FC<{
  gate: ConsentGate;
  granted: boolean;
  onChange: (granted: boolean) => void;
  /**
   * Display name (or email fallback) for `{{enumeratorName}}` in `gate.text`
   * and `gate.checkboxLabel` when substitution is enabled.
   */
  enumeratorDisplayName?: string | null;
}> = ({ gate, granted, onChange, enumeratorDisplayName }) => {
  const substitute = gate.substituteEnumeratorName !== false;
  const displayText = useMemo(
    () => formatConsentGateTemplate(gate.text, enumeratorDisplayName, substitute),
    [gate.text, enumeratorDisplayName, substitute]
  );
  const displayCheckboxLabel = useMemo(
    () => formatConsentGateTemplate(gate.checkboxLabel, enumeratorDisplayName, substitute),
    [gate.checkboxLabel, enumeratorDisplayName, substitute]
  );

  return (
    <div
      className={`rounded-lg overflow-hidden border ${
        granted ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/40'
      }`}
    >
      <div
        className={`px-4 py-2.5 text-white flex items-center gap-2 ${
          granted ? 'bg-emerald-600' : 'bg-amber-600'
        }`}
      >
        {granted ? <ShieldCheck size={16} /> : <Lock size={16} />}
        <div className="text-sm font-bold">{gate.title || 'Permission Grant'}</div>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{displayText}</p>
        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={granted}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-emerald-600"
          />
          <span className="text-sm font-semibold text-slate-800">
            {displayCheckboxLabel}
            <span className="text-red-500 ml-1">*</span>
          </span>
        </label>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// SubmissionGpsCaptureWidget — stabilization window + accuracy gate
// ---------------------------------------------------------------------------

interface CapturedSample {
  lat: number;
  lng: number;
  accuracy: number;
  takenAt: number;
}

type GpsCaptureState =
  | { phase: 'idle' }
  | { phase: 'watching'; startedAt: number; best: CapturedSample | null; samples: number }
  | { phase: 'locked'; best: CapturedSample; durationSeconds: number; samples: number }
  | { phase: 'error'; message: string };

export interface GpsCaptureWidgetProps {
  config: GpsCaptureSettings;
  title?: string;
  description?: string;
  variant?: 'card' | 'inline';
  onChange?: (
    sample: { lat: number; lng: number; accuracy: number; durationSeconds: number } | null
  ) => void;
}

export const SubmissionGpsCaptureWidget: React.FC<GpsCaptureWidgetProps> = ({
  config,
  title,
  description,
  variant = 'card',
  onChange
}) => {
  const [state, setState] = useState<GpsCaptureState>({ phase: 'idle' });
  const [elapsedSec, setElapsedSec] = useState(0);
  const watchIdRef = useRef<number | null>(null);
  const stopWatchTimerRef = useRef<number | null>(null);

  const clearWatch = () => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (stopWatchTimerRef.current != null) {
      clearInterval(stopWatchTimerRef.current);
      stopWatchTimerRef.current = null;
    }
  };

  useEffect(() => () => clearWatch(), []);

  useEffect(() => {
    if (!onChange) return;
    if (state.phase === 'locked') {
      onChange({
        lat: state.best.lat,
        lng: state.best.lng,
        accuracy: state.best.accuracy,
        durationSeconds: state.durationSeconds
      });
    } else if (state.phase === 'idle') {
      onChange(null);
    }
  }, [state, onChange]);

  const overrideLock = () => {
    setState((cur) => {
      if (cur.phase !== 'watching' || !cur.best) return cur;
      clearWatch();
      const elapsedMs = Date.now() - cur.startedAt;
      return {
        phase: 'locked',
        best: cur.best,
        durationSeconds: elapsedMs / 1000,
        samples: cur.samples
      };
    });
  };

  const start = () => {
    if (!('geolocation' in navigator)) {
      setState({ phase: 'error', message: 'Geolocation is not supported on this device.' });
      return;
    }
    clearWatch();
    const startedAt = Date.now();
    setElapsedSec(0);
    setState({ phase: 'watching', startedAt, best: null, samples: 0 });

    stopWatchTimerRef.current = window.setInterval(() => {
      setState((cur) => {
        if (cur.phase !== 'watching') return cur;
        const elapsedMs = Date.now() - cur.startedAt;
        setElapsedSec(Math.floor(elapsedMs / 100) / 10);
        if (
          cur.best &&
          cur.best.accuracy <= config.accuracyMeters &&
          elapsedMs >= config.stabilizationSeconds * 1000
        ) {
          clearWatch();
          return {
            phase: 'locked',
            best: cur.best,
            durationSeconds: elapsedMs / 1000,
            samples: cur.samples
          };
        }
        return cur;
      });
    }, 200);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const sample: CapturedSample = {
          lat: latitude,
          lng: longitude,
          accuracy: typeof accuracy === 'number' ? accuracy : Number.POSITIVE_INFINITY,
          takenAt: Date.now()
        };
        setState((cur) => {
          if (cur.phase !== 'watching') return cur;
          return {
            ...cur,
            samples: cur.samples + 1,
            best: !cur.best || sample.accuracy < cur.best.accuracy ? sample : cur.best
          };
        });
      },
      (err) => {
        clearWatch();
        setState({
          phase: 'error',
          message:
            err.code === err.PERMISSION_DENIED
              ? 'Location permission denied. Enable location services and retry.'
              : err.code === err.POSITION_UNAVAILABLE
                ? 'Location currently unavailable.'
                : err.code === err.TIMEOUT
                  ? 'GPS lookup timed out.'
                  : err.message
        });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    );
  };

  const reset = () => {
    clearWatch();
    setState({ phase: 'idle' });
    setElapsedSec(0);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (config.autoStart) start();
  }, []);

  const phase = state.phase;
  const headerTone =
    phase === 'locked'
      ? 'from-emerald-600 to-teal-600'
      : phase === 'error'
        ? 'from-red-600 to-rose-600'
        : 'from-emerald-500 to-teal-500';

  return (
    <div
      className={`rounded-lg overflow-hidden ${variant === 'card' ? 'border' : ''} ${
        phase === 'locked'
          ? 'border-emerald-200 bg-emerald-50/40'
          : phase === 'error'
            ? 'border-red-200 bg-red-50/40'
            : variant === 'card'
              ? 'border-emerald-200 bg-emerald-50/30'
              : ''
      }`}
    >
      {variant === 'card' && (
        <div className={`px-4 py-2.5 text-white flex items-center gap-2 bg-gradient-to-r ${headerTone}`}>
          <Satellite size={16} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold">{title || 'Submission GPS Location'}</div>
            <div className="text-[11px] text-white/90">
              Target accuracy ≤ {config.accuracyMeters} m • Stabilization{' '}
              {config.stabilizationSeconds} s
              {config.required && <> • Required</>}
            </div>
          </div>
        </div>
      )}

      <div className={variant === 'card' ? 'p-4 space-y-3' : 'space-y-3'}>
        {description && (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{description}</p>
        )}

        {phase === 'idle' && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Crosshair size={14} className="text-emerald-600" />
              GPS is not yet acquired.
            </div>
            <button
              onClick={start}
              className="text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-md flex items-center gap-2"
            >
              <Locate size={15} /> Capture GPS Location
            </button>
          </div>
        )}

        {phase === 'watching' && (
          <WatchingPanel
            state={state as Extract<GpsCaptureState, { phase: 'watching' }>}
            elapsedSec={elapsedSec}
            config={config}
            onCancel={reset}
            onOverride={overrideLock}
          />
        )}

        {phase === 'locked' && (
          <LockedPanel
            state={state as Extract<GpsCaptureState, { phase: 'locked' }>}
            onRetake={reset}
          />
        )}

        {phase === 'error' && (
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="text-red-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-red-700 font-semibold">
                {(state as Extract<GpsCaptureState, { phase: 'error' }>).message}
              </p>
              <button
                onClick={start}
                className="mt-2 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-md"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Lightweight OpenStreetMap preview rendered via OSM's standard embed iframe.
 * No JS map library is loaded — just an HTML iframe — so this stays cheap
 * even on low-end devices. The bbox tightens around the marker so the pin is
 * always centered and visible; we cap the span so a poor first-fix
 * (accuracy in hundreds of meters) doesn't zoom out to a useless level.
 *
 * Offline fallback: the iframe points at openstreetmap.org so it can't load
 * without network. When `navigator.onLine === false` we render an
 * SVG/CSS-only "compass-style" preview that still confirms the capture —
 * coordinates, accuracy, and a centered crosshair with a scaled accuracy
 * ring — so the enumerator gets the same "yes, my fix was recorded" signal
 * they get online.
 */
const OsmMiniMap: React.FC<{ lat: number; lng: number; accuracy?: number }> = ({
  lat,
  lng,
  accuracy
}) => {
  // Track online state locally so reconnecting (or going offline mid-survey)
  // swaps the preview without remounting the parent.
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // span ~ degrees on each side of the marker. ~0.0015° ≈ 150 m at the equator.
  const acc = typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : 50;
  const span = Math.max(0.0015, Math.min(0.015, acc / 30000));
  const bbox = [
    (lng - span).toFixed(6),
    (lat - span).toFixed(6),
    (lng + span).toFixed(6),
    (lat + span).toFixed(6)
  ].join(',');
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(
    6
  )},${lng.toFixed(6)}`;
  const viewUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat.toFixed(
    5
  )}/${lng.toFixed(5)}`;

  if (!isOnline) {
    // Map the accuracy onto a visual ring radius. Real-world feel: 5 m fix
    // shows tight, 100 m fix shows a wider "uncertainty" ring. Capped so a
    // very poor fix doesn't blow past the card edges.
    const ringRadius = Math.min(60, Math.max(8, acc));
    return (
      <div className="rounded-md border border-amber-200 overflow-hidden bg-gradient-to-br from-slate-50 to-amber-50/50">
        <div className="relative h-40 sm:h-44 flex items-center justify-center">
          {/* Subtle grid backdrop so the user sees a 'map-ish' canvas, not
              a blank white box. Pure CSS, no network. */}
          <div
            className="absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                'linear-gradient(to right, rgba(15,23,42,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,0.06) 1px, transparent 1px)',
              backgroundSize: '20px 20px'
            }}
          />
          {/* Accuracy ring + crosshair pin */}
          <div className="relative" style={{ width: ringRadius * 2, height: ringRadius * 2 }}>
            <div
              className="absolute inset-0 rounded-full border-2 border-amber-500/50 bg-amber-500/15 animate-pulse"
              aria-hidden
            />
          </div>
          <div className="absolute w-3 h-3 rounded-full bg-amber-600 ring-4 ring-white shadow" aria-hidden />
          <div className="absolute top-1.5 left-1.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
            Offline preview
          </div>
        </div>
        <div className="px-2.5 py-1.5 text-[10px] text-slate-600 flex items-center justify-between gap-2 border-t border-amber-100 bg-white/70">
          <span className="font-mono">
            {lat.toFixed(6)}, {lng.toFixed(6)}
            {Number.isFinite(acc) && <> · ±{Math.round(acc)} m</>}
          </span>
          <span className="shrink-0 text-amber-700 font-semibold">
            Map will load when online
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-emerald-200/80 overflow-hidden bg-white">
      {/* The OSM embed paints an attribution / donation strip across the
          bottom of its own document. We can't style across the cross-origin
          iframe, so instead we make the iframe taller than the visible
          area and clip it — the visible window shows just the map. A
          tiny "© OSM" link in the footer strip below preserves the
          required attribution. */}
      <div className="relative overflow-hidden h-40 sm:h-44">
        <iframe
          key={src}
          title="GPS location preview"
          src={src}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute inset-x-0 top-0 w-full block"
          style={{ border: 0, height: 'calc(100% + 36px)' }}
        />
      </div>
      <div className="px-2.5 py-1 text-[10px] text-slate-500 flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60">
        <span className="truncate">Marker = your device's current position.</span>
        <a
          href={viewUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-emerald-700 hover:text-emerald-800 font-semibold"
        >
          © OSM ↗
        </a>
      </div>
    </div>
  );
};

const WatchingPanel: React.FC<{
  state: Extract<GpsCaptureState, { phase: 'watching' }>;
  elapsedSec: number;
  config: GpsCaptureSettings;
  onCancel: () => void;
  onOverride?: () => void;
}> = ({ state, elapsedSec, config, onCancel, onOverride }) => {
  const stabilizeProgress = Math.min(100, (elapsedSec / config.stabilizationSeconds) * 100);
  const bestAccuracy = state.best?.accuracy;
  const accuracyOk = typeof bestAccuracy === 'number' && bestAccuracy <= config.accuracyMeters;
  const stabilized = elapsedSec >= config.stabilizationSeconds;
  const canOverride = config.allowManualOverride && stabilized && state.best && !accuracyOk;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 size={16} className="text-emerald-600 animate-spin" />
        <span className="font-semibold text-emerald-700">Acquiring high-accuracy GPS…</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Elapsed"
          value={`${elapsedSec.toFixed(1)} s`}
          hint={`min ${config.stabilizationSeconds} s`}
          ok={stabilized}
        />
        <Stat
          label="Best Accuracy"
          value={typeof bestAccuracy === 'number' ? `${bestAccuracy.toFixed(1)} m` : '—'}
          hint={`target ≤ ${config.accuracyMeters} m`}
          ok={accuracyOk}
        />
      </div>

      <div>
        <div className="flex justify-between text-[10px] font-semibold text-slate-500 mb-1">
          <span>Stabilization</span>
          <span>{Math.round(stabilizeProgress)}%</span>
        </div>
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${stabilizeProgress}%` }} />
        </div>
      </div>

      {state.best && (
        <OsmMiniMap
          lat={state.best.lat}
          lng={state.best.lng}
          accuracy={state.best.accuracy}
        />
      )}

      <p className="text-[11px] text-slate-500 italic">
        {state.samples} sample{state.samples === 1 ? '' : 's'} received. Stand still and keep the
        device under open sky for best results.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onCancel} className="text-xs font-semibold text-slate-600 hover:text-slate-800 underline">
          Cancel and reset
        </button>
        {canOverride && onOverride && (
          <button
            onClick={onOverride}
            className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline"
            title="Save the best sample so far even though accuracy is above the threshold"
          >
            Use anyway (±{bestAccuracy?.toFixed(1)} m)
          </button>
        )}
      </div>
    </div>
  );
};

const LockedPanel: React.FC<{
  state: Extract<GpsCaptureState, { phase: 'locked' }>;
  onRetake: () => void;
}> = ({ state, onRetake }) => {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <CheckCircle2 size={16} className="text-emerald-600" />
        <span className="font-semibold text-emerald-700">Location captured successfully.</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Latitude" value={state.best.lat.toFixed(6)} />
        <Stat label="Longitude" value={state.best.lng.toFixed(6)} />
        <Stat label="Accuracy" value={`${state.best.accuracy.toFixed(1)} m`} ok />
        <Stat
          label="Duration"
          value={`${state.durationSeconds.toFixed(1)} s`}
          hint={`${state.samples} sample${state.samples === 1 ? '' : 's'}`}
        />
      </div>
      <OsmMiniMap
        lat={state.best.lat}
        lng={state.best.lng}
        accuracy={state.best.accuracy}
      />
      <button onClick={onRetake} className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 underline">
        Re-capture
      </button>
    </div>
  );
};

const Stat: React.FC<{
  label: string;
  value: string;
  hint?: string;
  ok?: boolean;
}> = ({ label, value, hint, ok }) => (
  <div className={`border rounded-md px-2.5 py-1.5 ${ok ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white'}`}>
    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</div>
    <div className="text-sm font-bold text-slate-800 break-all">{value}</div>
    {hint && <div className="text-[10px] text-slate-400">{hint}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// RuntimeQuestion — renders a single question's input control
// ---------------------------------------------------------------------------

export const RuntimeQuestion: React.FC<{
  index: number;
  /**
   * Hierarchical label printed before the prompt (e.g. `"3"` or
   * `"3.a"`). When omitted we fall back to the legacy `index + 1`
   * numbering so existing call-sites keep working.
   */
  numberLabel?: string;
  question: Question;
  value: unknown;
  onChange: (v: unknown) => void;
  /**
   * Full snapshot of the form's current answers, used to evaluate
   * `computed` questions. Optional so existing call-sites that only
   * render simple input controls keep working.
   */
  allAnswers?: Record<string, unknown>;
  /** Sibling questions, used by `computed` to resolve operand keys. */
  allQuestions?: Question[];
}> = ({ index, numberLabel, question, value, onChange, allAnswers, allQuestions }) => {
  const opts =
    question.type === 'section' ? [] : ensureOptionShape(question.options);
  const cls = 'w-full text-sm border border-slate-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500';
  const answersMap = allAnswers ?? {};

  const getOptionDisabled = useCallback(
    (optValue: string) => {
      const o = opts.find((x) => x.value === optValue);
      return o ? isChoiceOptionDisabled(o, answersMap) : false;
    },
    [opts, answersMap]
  );

  useEffect(() => {
    if (question.type !== 'multiselect' && question.type !== 'checkbox') return;
    const optionList = ensureOptionShape(question.options);
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const filtered = arr.filter((pv) => {
      const o = optionList.find((x) => x.value === pv);
      return !o || !isChoiceOptionDisabled(o, answersMap);
    });
    if (filtered.length !== arr.length) onChange(filtered);
  }, [question.type, question.id, question.options, value, answersMap, onChange]);

  if (question.type === 'section') {
    return (
      <div className="border-t-2 border-indigo-200 pt-3">
        <div className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">Section</div>
        <h4 className="text-base font-bold text-slate-900">{question.question}</h4>
        {question.description && <p className="text-xs text-slate-500 mt-1">{question.description}</p>}
      </div>
    );
  }

  let body: React.ReactNode = null;
  switch (question.type) {
    case 'text':
    case 'email':
    case 'phone':
      body = (
        <input
          // Map question type → HTML input type so mobile browsers
          // surface the right virtual keyboard layout (numeric pad for
          // phones, email layout with `@` and `.com` keys for emails).
          // Browser-side `type="email"` also adds free spell-check
          // suppression which prevents annoying autocorrect on emails.
          type={
            question.type === 'email' ? 'email' : question.type === 'phone' ? 'tel' : 'text'
          }
          inputMode={question.type === 'phone' ? 'tel' : undefined}
          autoComplete={
            question.type === 'email' ? 'email' : question.type === 'phone' ? 'tel' : undefined
          }
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            question.placeholder ||
            (question.type === 'email'
              ? 'name@example.com'
              : question.type === 'phone'
                ? '01712345678'
                : undefined)
          }
          className={cls}
        />
      );
      break;
    case 'longtext':
      body = (
        <textarea
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={question.placeholder}
          rows={3}
          className={`${cls} resize-none`}
        />
      );
      break;
    case 'number':
      body = (
        <input
          type="number"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={question.placeholder}
          min={question.validation?.min}
          max={question.validation?.max}
          step={question.validation?.step}
          className={cls}
        />
      );
      break;
    case 'age': {
      // Two-input composite: years + months. Stored as `{ years, months,
      // totalMonths }` so admins can sort on either dimension and the CSV
      // export can render both columns. Empty input is preserved as
      // `undefined` so the "required" validator can still reject blanks.
      const ageVal = (value && typeof value === 'object' ? value : {}) as {
        years?: number | string;
        months?: number | string;
      };
      const yrs = ageVal.years === undefined ? '' : String(ageVal.years);
      const mos = ageVal.months === undefined ? '' : String(ageVal.months);
      const commit = (nextYears: string, nextMonths: string) => {
        const y = nextYears === '' ? undefined : Math.max(0, Number(nextYears));
        const mRaw = nextMonths === '' ? undefined : Math.max(0, Number(nextMonths));
        const m = mRaw === undefined ? undefined : Math.min(11, mRaw);
        if (y === undefined && m === undefined) {
          onChange(undefined);
          return;
        }
        const yy = y ?? 0;
        const mm = m ?? 0;
        onChange({ years: yy, months: mm, totalMonths: yy * 12 + mm });
      };
      body = (
        <div className="flex items-stretch gap-2">
          <div className="flex-1 min-w-0">
            <div className="relative">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={150}
                step={1}
                value={yrs}
                onChange={(e) => commit(e.target.value, mos)}
                placeholder="0"
                className={`${cls} pr-12`}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Years
              </span>
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="relative">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={11}
                step={1}
                value={mos}
                onChange={(e) => commit(yrs, e.target.value)}
                placeholder="0"
                className={`${cls} pr-14`}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Months
              </span>
            </div>
          </div>
        </div>
      );
      break;
    }
    case 'computed': {
      // The form layer is responsible for actually writing the computed
      // result into `responses` (so it persists on submit). Here we just
      // mirror the live calculation back to the enumerator — re-running
      // it on every render keeps the value in sync the moment any
      // operand answer changes, with zero extra subscriptions.
      const res = evaluateComputed(
        question.computed,
        allAnswers ?? {},
        allQuestions ?? []
      );
      body = (
        <ComputedAnswerCell
          display={res.display}
          spec={question.computed}
        />
      );
      break;
    }
    case 'date':
      body = <input type="date" value={(value as string) || ''} onChange={(e) => onChange(e.target.value)} className={cls} />;
      break;
    case 'time':
      body = <input type="time" value={(value as string) || ''} onChange={(e) => onChange(e.target.value)} className={cls} />;
      break;
    case 'datetime':
      body = <input type="datetime-local" value={(value as string) || ''} onChange={(e) => onChange(e.target.value)} className={cls} />;
      break;
    case 'select':
      body = (
        <ChoiceWithOtherFields
          mode="select"
          name={question.id}
          options={opts}
          allowOther={question.allowOther}
          value={value}
          onChange={onChange}
          className={cls}
          getOptionDisabled={getOptionDisabled}
        />
      );
      break;
    case 'multiselect':
      body = (
        <select
          multiple
          value={(value as string[]) || []}
          onChange={(e) => {
            const picked = Array.from(
              e.target.selectedOptions as HTMLCollectionOf<HTMLOptionElement>
            ).map((o) => o.value);
            const filtered = picked.filter((pv) => {
              const o = opts.find((x) => x.value === pv);
              return !o || !isChoiceOptionDisabled(o, answersMap);
            });
            onChange(filtered);
          }}
          className={`${cls} h-32`}
        >
          {opts.map((o) => (
            <option key={o.id} value={o.value} disabled={isChoiceOptionDisabled(o, answersMap)}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'radio':
      body = (
        <ChoiceWithOtherFields
          mode="radio"
          name={question.id}
          options={opts}
          allowOther={question.allowOther}
          value={value}
          onChange={onChange}
          className={cls}
          getOptionDisabled={getOptionDisabled}
        />
      );
      break;
    case 'checkbox':
      body = (
        <div className="space-y-1.5">
          {opts.map((o) => {
            const arr = Array.isArray(value) ? (value as string[]) : [];
            return (
              <label
                key={o.id}
                className={`flex items-center gap-2 text-sm ${
                  isChoiceOptionDisabled(o, answersMap) ? 'text-slate-400' : 'text-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={isChoiceOptionDisabled(o, answersMap)}
                  checked={arr.includes(o.value)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))
                  }
                />
                {o.label}
              </label>
            );
          })}
        </div>
      );
      break;
    case 'rating': {
      const max = question.validation?.max ?? 5;
      const cur = Number(value || 0);
      body = (
        <div className="flex gap-1">
          {Array.from({ length: max }).map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onChange(i + 1)}
              className={i < cur ? 'text-amber-400' : 'text-slate-300'}
            >
              <Star size={22} fill={i < cur ? 'currentColor' : 'none'} />
            </button>
          ))}
        </div>
      );
      break;
    }
    case 'scale': {
      const min = question.validation?.min ?? 1;
      const max = question.validation?.max ?? 10;
      const cur = Number(value || min);
      body = (
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-slate-500">{min}</span>
          <input
            type="range"
            min={min}
            max={max}
            value={cur}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1"
          />
          <span className="text-xs font-semibold text-slate-500">{max}</span>
          <span className="text-sm font-bold text-blue-700 w-8 text-right">{cur}</span>
        </div>
      );
      break;
    }
    case 'location': {
      const gpsCfg: GpsCaptureSettings = {
        accuracyMeters: question.gpsSettings?.accuracyMeters ?? 10,
        stabilizationSeconds: question.gpsSettings?.stabilizationSeconds ?? 10,
        required: question.gpsSettings?.required ?? question.required ?? false,
        autoStart: question.gpsSettings?.autoStart ?? false,
        allowManualOverride: question.gpsSettings?.allowManualOverride ?? false
      };
      body = (
        <SubmissionGpsCaptureWidget
          config={gpsCfg}
          variant="card"
          onChange={(s) =>
            onChange(
              s
                ? {
                    lat: s.lat,
                    lng: s.lng,
                    accuracy: s.accuracy,
                    durationSeconds: s.durationSeconds
                  }
                : null
            )
          }
        />
      );
      break;
    }
    case 'matrix':
      body = (
        <div className="space-y-1">
          <p className="text-[11px] text-slate-500">
            Select one option in each row — every row is required (e.g. হ্যাঁ or না).
          </p>
          <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th />
                {(question.columns || []).map((c) => (
                  <th key={c} className="text-xs font-semibold text-slate-600 px-2 py-1">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(question.rows || []).map((r) => {
                const matrixVal = (value as Record<string, string>) || {};
                return (
                  <tr key={r} className="border-t border-slate-100">
                    <td className="text-xs text-slate-700 pr-2">{r}</td>
                    {(question.columns || []).map((c) => (
                      <td key={`${r}_${c}`} className="text-center px-2 py-1">
                        <input
                          type="radio"
                          name={`${question.id}_${r}`}
                          checked={matrixVal[r] === c}
                          onChange={() => onChange({ ...matrixVal, [r]: c })}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      );
      break;
    default:
      body = (
        <div className="text-xs text-slate-500 italic">
          (This question type isn't supported yet.)
        </div>
      );
  }

  const prefix = numberLabel !== undefined ? numberLabel : String(index + 1);
  return (
    <div className="space-y-2">
      <label className="block text-sm font-semibold text-slate-800">
        {prefix !== '' && `${prefix}. `}
        {question.question || 'Untitled question'}
        {question.required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {question.description && <p className="text-xs text-slate-500 -mt-1">{question.description}</p>}
      {body}
    </div>
  );
};
