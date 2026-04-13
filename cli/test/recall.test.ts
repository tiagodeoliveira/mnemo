import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { executeRecall, formatRecallOutput } from '../src/commands/recall';

const sampleResponse = {
  preferences: [
    { id: 'r1', content: 'Prefers TypeScript and functional style', score: 0.95, createdAt: '' },
  ],
  facts: [
    { id: 'r2', content: 'Senior engineer working on distributed systems', score: 0.9, createdAt: '' },
  ],
  episodes: [],
  project: {
    name: 'mnemo',
    memories: [
      { id: 'r3', content: 'Chose CDK over SAM for infrastructure', score: 0.85, createdAt: '' },
    ],
  },
};

describe('recall command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleResponse),
    });
  });

  it('calls /recall with project param', async () => {
    await executeRecall({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      project: 'mnemo',
      workstation: 'laptop',
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/recall?project=mnemo&workstation=laptop');
    expect(options.headers['x-api-key']).toBe('test-key');
  });

  it('omits project param when not provided', async () => {
    await executeRecall({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      workstation: 'laptop',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/recall?workstation=laptop');
  });

  it('passes task param to /recall', async () => {
    await executeRecall({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      project: 'mnemo',
      workstation: 'laptop',
      task: 'coding',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('task=coding');
  });

  it('passes date param to /recall', async () => {
    await executeRecall({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      workstation: 'laptop',
      date: '2026-04-13',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('date=2026-04-13');
  });
});

describe('formatRecallOutput', () => {
  it('formats response for visible mode', () => {
    const output = formatRecallOutput(sampleResponse, true);
    expect(output).toContain('Prefers TypeScript');
    expect(output).toContain('Senior engineer');
    expect(output).toContain('mnemo');
    expect(output).toContain('Chose CDK over SAM');
  });

  it('formats response for silent mode as JSON system message', () => {
    const output = formatRecallOutput(sampleResponse, false);
    const parsed = JSON.parse(output);
    expect(parsed.systemMessage).toBeDefined();
  });

  it('extracts plain text from JSON preference content', () => {
    const response = {
      preferences: [
        {
          id: 'r1',
          content: '{"context":"User said they like TS","preference":"Always use TypeScript","categories":["lang"]}',
          score: 0.95,
          createdAt: '',
        },
      ],
      facts: [],
      episodes: [],
    };
    const output = formatRecallOutput(response, true);
    expect(output).toContain('- Always use TypeScript');
    expect(output).not.toContain('"context"');
  });

  it('formats episodic content with title/use_cases/hints as markdown', () => {
    const response = {
      preferences: [],
      facts: [],
      episodes: [
        {
          id: 'e1',
          content: JSON.stringify({
            title: 'Debugging IAM Propagation',
            use_cases: 'Applies when deploying AgentCore resources',
            hints: 'Check both identity and resource policies',
            confidence: '0.9',
          }),
          score: 0.85,
          createdAt: '',
        },
      ],
    };
    const output = formatRecallOutput(response, true);
    expect(output).toContain('### Debugging IAM Propagation');
    expect(output).toContain('**Use cases:** Applies when deploying');
    expect(output).toContain('**Hints:** Check both identity');
    expect(output).toContain('**Confidence:** 0.9');
    expect(output).not.toContain('"title"');
  });

  it('formats episodic content with situation/turns as markdown', () => {
    const response = {
      preferences: [],
      facts: [],
      episodes: [
        {
          id: 'e2',
          content: JSON.stringify({
            situation: 'User explained CfnMemory migration',
            intent: 'Validate architectural decision',
            assessment: 'Yes',
            justification: 'Assistant confirmed understanding',
            reflection: 'Direct acknowledgment was sufficient',
            turns: [
              {
                situation: 'Explaining CfnMemory choice',
                intent: 'Seek validation',
                action: 'Provided affirmative response',
                thought: 'Showed understanding of rationale',
                assessmentAssistant: 'Validated successfully',
                assessmentUser: 'No follow-up needed',
              },
            ],
          }),
          score: 0.8,
          createdAt: '',
        },
      ],
    };
    const output = formatRecallOutput(response, true);
    expect(output).toContain('**Situation:** User explained CfnMemory migration');
    expect(output).toContain('**Intent:** Validate architectural decision');
    expect(output).toContain('**Assessment:** Yes');
    expect(output).toContain('**Reflection:** Direct acknowledgment was sufficient');
    expect(output).toContain('**Turns:**');
    expect(output).toContain('**Action:** Provided affirmative response');
    expect(output).not.toContain('"situation"');
  });

  it('passes through non-JSON episode content as-is', () => {
    const response = {
      preferences: [],
      facts: [],
      episodes: [
        {
          id: 'e3',
          content: 'Plain text episode about debugging session',
          score: 0.7,
          createdAt: '',
        },
      ],
    };
    const output = formatRecallOutput(response, true);
    expect(output).toContain('Plain text episode about debugging session');
  });

  it('formats tasks and daily sections', () => {
    const response = {
      preferences: [],
      facts: [],
      episodes: [],
      tasks: {
        name: 'coding',
        memories: [
          { id: 't1', content: 'Prefers TDD workflow', score: 0.9, createdAt: '' },
        ],
      },
      daily: {
        date: '2026-04-13',
        memories: [
          { id: 'd1', content: 'Worked on mnemo context extractor', score: 0.85, createdAt: '' },
        ],
      },
    };
    const output = formatRecallOutput(response, true);
    expect(output).toContain('## Task: coding');
    expect(output).toContain('Prefers TDD workflow');
    expect(output).toContain('## Daily: 2026-04-13');
    expect(output).toContain('Worked on mnemo context extractor');
  });
});
