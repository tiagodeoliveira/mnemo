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

export const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

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
  // TODO(user): implement. ~10 lines. See tests in test/lambda/recall-filter.test.ts.
  void OPERATOR_SUFFIXES;
  void KEY_PATTERN;
  throw new FilterParseError(`not implemented: ${raw}`);
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
