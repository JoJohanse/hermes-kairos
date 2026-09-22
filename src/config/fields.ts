/**
 * Shared configuration-field vocabulary.
 *
 * Kernel and plugin config modules both speak this tiny language: a warning
 * contract for silently-rejected fields plus generic typed readers. It imports
 * nothing (no kernel code, no plugin code), so either side can depend on it
 * without creating an ownership inversion.
 */

/** A field that could not be honored, plus why it was replaced by a default. */
export interface ConfigWarning {
  /** Dotted path of the offending field, e.g. `decision.sendThreshold`. */
  field: string;
  /** The raw value that was rejected. */
  value: unknown;
  /** Human-readable reason the value was not used. */
  reason: string;
}

/** Sink for {@link ConfigWarning}s. Defaults to `console.warn`. */
export type ConfigWarnHandler = (warning: ConfigWarning) => void;

/** Default warning sink: logs a `[config]`-prefixed line to `console.warn`. */
export const defaultConfigWarn: ConfigWarnHandler = (warning) => {
  let rendered: string;
  try {
    rendered = JSON.stringify(warning.value) ?? String(warning.value);
  } catch {
    rendered = String(warning.value);
  }
  console.warn(`[config] ${warning.field}: ${warning.reason} (received ${rendered})`);
};

/** Emit `warning` through `warn` when `condition` holds. */
export function warnIf(
  warn: ConfigWarnHandler,
  field: string,
  value: unknown,
  condition: boolean,
  reason: string,
): void {
  if (condition) warn({ field, value, reason });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merge `override` into `base`, returning a new object. */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

export function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

export function stringFrom(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

export function booleanFrom(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

const CLOCK_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Read a finite number, warning when a present value must be defaulted. */
export function numberField(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  warn: ConfigWarnHandler,
  field: string,
): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (isFiniteNumber(value)) return value;
  warn({ field, value, reason: 'expected a finite number; using default' });
  return fallback;
}

/** Read a non-empty string, warning when a present value must be defaulted. */
export function stringField(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  warn: ConfigWarnHandler,
  field: string,
): string {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() !== '') return value;
  warn({ field, value, reason: 'expected a non-empty string; using default' });
  return fallback;
}

export function clockFrom(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  warn: ConfigWarnHandler,
  field: string,
): string {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string' && CLOCK_PATTERN.test(value.trim())) return value.trim();
  warn({ field, value, reason: 'expected an HH:MM clock; using default' });
  return fallback;
}

export function stringAllowEmptyFrom(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  warn: ConfigWarnHandler,
  field: string,
): string {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string') return value;
  warn({ field, value, reason: 'expected a string; using default' });
  return fallback;
}
