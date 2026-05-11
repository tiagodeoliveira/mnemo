import {
  OperatorType,
  type MemoryMetadataFilterExpression,
} from '@aws-sdk/client-bedrock-agentcore';

export const MAX_FILTERS = 5;

export class FilterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterParseError';
  }
}

// AgentCore's RetrieveMemoryRecords filter currently supports only these three
// operators (SDK 3.1045 — MemoryMetadataFilterExpression.operator is typed as
// OperatorType). The public docs advertise BEFORE/AFTER/CONTAINS/comparison
// operators via a different enum (MemoryRecordOperatorType) that isn't yet
// wired into this command. Add suffixes to OPERATOR_SUFFIXES when the SDK
// expands — the parser is intentionally data-driven for that reason.
type Operator = (typeof OperatorType)[keyof typeof OperatorType];

interface ParsedExpression {
  key: string;
  operator: Operator;
  value?: string;
}

// Order matters when more operators land: longer suffixes must be checked
// before their prefixes (e.g., `>=` before `>`). Today only `:` is defined,
// so order is moot — but keep the scan-in-order pattern for forward
// compatibility.
export const OPERATOR_SUFFIXES: Array<[string, Operator]> = [
  [':', OperatorType.EQUALS_TO],
];

// AgentCore's service-side key pattern for memory record metadata is
// [a-zA-Z0-9\s._:/=+@-]* with max length 128 (see API_MemoryRecordLeftExpression).
// We omit whitespace and our operator punctuation (`:`, `?`, `!`) from the
// parser-accepted set because those are structural in the DSL, and we require
// the key to start with a letter so leading digits/punctuation aren't confused
// with malformed values.
export const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9._/=+@-]{0,127}$/;

/**
 * Parse a single expression like "project:mnemo", "tags?" (EXISTS), or
 * "archived!" (NOT_EXISTS) into a ParsedExpression.
 *
 * Rules:
 * - Trailing `?` (no value) → EXISTS
 * - Trailing `!` (no value) → NOT_EXISTS
 * - Otherwise: scan OPERATOR_SUFFIXES in order, split on the *first* match,
 *   key = left, value = right. Both must be non-empty.
 * - Key must match KEY_PATTERN (alphanumeric + underscore, starts with letter).
 * - On any malformed input, throw FilterParseError with a helpful message
 *   that includes the bad input — these become 400 responses to API callers.
 *
 * Test cases the implementation must satisfy (see recall-filter.test.ts):
 *   parseExpression("project:mnemo")       → { key:"project",  op:EQUALS_TO,    value:"mnemo" }
 *   parseExpression("tags?")               → { key:"tags",     op:EXISTS }
 *   parseExpression("archived!")           → { key:"archived", op:NOT_EXISTS }
 *   parseExpression("source:claude:code")  → { key:"source",   op:EQUALS_TO,    value:"claude:code" }
 *   parseExpression("nokey")               → throws FilterParseError
 *   parseExpression(":nokey")              → throws FilterParseError
 *   parseExpression("key:")                → throws FilterParseError
 *   parseExpression("bad-key:x")           → throws FilterParseError
 */
function parseExpression(raw: string): ParsedExpression {
  const expr = raw.trim();
  if (!expr) throw new FilterParseError(`Empty filter expression`);

  // EXISTS / NOT_EXISTS: trailing `?` or `!` with no value, key is everything before.
  const last = expr[expr.length - 1];
  if (last === '?' || last === '!') {
    const key = expr.slice(0, -1);
    if (!KEY_PATTERN.test(key)) {
      throw new FilterParseError(`Invalid filter key "${key}" in "${raw}"`);
    }
    return { key, operator: last === '?' ? OperatorType.EXISTS : OperatorType.NOT_EXISTS };
  }

  // EQUALS_TO and future operators: scan OPERATOR_SUFFIXES in declared order
  // and split on the first match. Only the leftmost occurrence splits, so
  // operator characters inside the value (e.g., "source:claude:code") survive.
  for (const [suffix, operator] of OPERATOR_SUFFIXES) {
    const idx = expr.indexOf(suffix);
    if (idx === -1) continue;
    const key = expr.slice(0, idx);
    const value = expr.slice(idx + suffix.length);
    if (!KEY_PATTERN.test(key)) {
      throw new FilterParseError(`Invalid filter key "${key}" in "${raw}"`);
    }
    if (!value) {
      throw new FilterParseError(`Empty filter value in "${raw}"`);
    }
    return { key, operator, value };
  }

  throw new FilterParseError(`Filter expression "${raw}" is missing an operator (expected ":", "?", or "!")`);
}

/**
 * Parse the full ?filter=... query string into AgentCore's wire shape.
 * Returns undefined if the input is empty/undefined (no filter applied).
 *
 * Throws FilterParseError on:
 *   - more than MAX_FILTERS expressions
 *   - any single expression failing parseExpression
 */
export function parseFilter(input: string | undefined): MemoryMetadataFilterExpression[] | undefined {
  if (!input) return undefined;
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length > MAX_FILTERS) {
    throw new FilterParseError(`Too many filter expressions: ${parts.length} > ${MAX_FILTERS}`);
  }
  return parts.map(parseExpression).map(toAwsShape);
}

function toAwsShape(p: ParsedExpression): MemoryMetadataFilterExpression {
  const left = { metadataKey: p.key };
  if (p.operator === OperatorType.EXISTS || p.operator === OperatorType.NOT_EXISTS) {
    return { left, operator: p.operator };
  }
  return {
    left,
    operator: p.operator,
    right: { metadataValue: { stringValue: p.value! } },
  };
}
