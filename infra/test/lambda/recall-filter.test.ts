import { describe, expect, it } from 'vitest';
import { FilterParseError, MAX_FILTERS, parseFilter } from '../../lambda/recall/filter';

describe('parseFilter', () => {
  it('returns undefined for empty/missing input', () => {
    expect(parseFilter(undefined)).toBeUndefined();
    expect(parseFilter('')).toBeUndefined();
    expect(parseFilter('   ')).toBeUndefined();
    expect(parseFilter(',,,')).toBeUndefined();
  });

  it('parses EQUALS_TO with `:`', () => {
    expect(parseFilter('project:mnemo')).toEqual([
      {
        left: { metadataKey: 'project' },
        operator: 'EQUALS_TO',
        right: { metadataValue: { stringValue: 'mnemo' } },
      },
    ]);
  });

  it('parses EXISTS via trailing `?`', () => {
    expect(parseFilter('tags?')).toEqual([
      { left: { metadataKey: 'tags' }, operator: 'EXISTS' },
    ]);
  });

  it('parses NOT_EXISTS via trailing `!`', () => {
    expect(parseFilter('archived!')).toEqual([
      { left: { metadataKey: 'archived' }, operator: 'NOT_EXISTS' },
    ]);
  });

  it('preserves `:` characters inside the value (only the first `:` splits)', () => {
    expect(parseFilter('source:claude:code')).toEqual([
      {
        left: { metadataKey: 'source' },
        operator: 'EQUALS_TO',
        right: { metadataValue: { stringValue: 'claude:code' } },
      },
    ]);
  });

  it('parses multiple comma-separated expressions and ANDs them', () => {
    expect(parseFilter('project:mnemo,source:codex,tags?')).toEqual([
      {
        left: { metadataKey: 'project' },
        operator: 'EQUALS_TO',
        right: { metadataValue: { stringValue: 'mnemo' } },
      },
      {
        left: { metadataKey: 'source' },
        operator: 'EQUALS_TO',
        right: { metadataValue: { stringValue: 'codex' } },
      },
      { left: { metadataKey: 'tags' }, operator: 'EXISTS' },
    ]);
  });

  it('rejects more than MAX_FILTERS expressions', () => {
    const tooMany = Array.from({ length: MAX_FILTERS + 1 }, (_, i) => `k${i}:v`).join(',');
    expect(() => parseFilter(tooMany)).toThrow(FilterParseError);
  });

  it('rejects malformed input', () => {
    expect(() => parseFilter('nokey')).toThrow(FilterParseError);          // no operator
    expect(() => parseFilter(':novalue')).toThrow(FilterParseError);        // empty key
    expect(() => parseFilter('key:')).toThrow(FilterParseError);            // empty value
    expect(() => parseFilter('bad-key:x')).toThrow(FilterParseError);       // hyphen in key
    expect(() => parseFilter('1bad:x')).toThrow(FilterParseError);          // key starts with digit
  });
});
