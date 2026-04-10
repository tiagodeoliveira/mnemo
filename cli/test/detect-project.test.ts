import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectProject } from '../src/detect-project';
import * as childProcess from 'child_process';

vi.mock('child_process');

describe('detectProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns folder name when in a git repo', () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(
      '/Users/tiago/src/github.com/tiagodeoliveira/mnemo\n'
    );

    const result = detectProject('/Users/tiago/src/github.com/tiagodeoliveira/mnemo/src');
    expect(result).toBe('mnemo');
  });

  it('returns undefined when not in a git repo', () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const result = detectProject('/tmp/random-dir');
    expect(result).toBeUndefined();
  });
});
