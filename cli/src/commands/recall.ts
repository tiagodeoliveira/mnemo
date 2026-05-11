export interface RecallOptions {
  apiUrl: string;
  apiKey: string;
  workstation: string;
  preferences?: boolean;
  facts?: boolean;
  episodes?: boolean;
  about?: boolean;
  project?: string;
  task?: string;
  date?: string;
  /** Optional query override used as searchQuery against every requested dimension. */
  q?: string;
}

interface MemoryRecord {
  id: string;
  content: string;
  score: number;
  createdAt: string;
}

interface RecallResponse {
  preferences?: MemoryRecord[];
  facts?: MemoryRecord[];
  episodes?: MemoryRecord[];
  about?: MemoryRecord[];
  project?: {
    name: string;
    memories: MemoryRecord[];
  };
  tasks?: {
    name: string;
    memories: MemoryRecord[];
  };
  daily?: {
    date: string;
    memories: MemoryRecord[];
  };
}

export async function executeRecall(options: RecallOptions): Promise<RecallResponse> {
  const params = new URLSearchParams();
  if (options.preferences) params.set('preferences', 'true');
  if (options.facts) params.set('facts', 'true');
  if (options.episodes) params.set('episodes', 'true');
  if (options.about) params.set('about', 'true');
  if (options.q) params.set('q', options.q);
  if (options.project) params.set('project', options.project);
  if (options.task) params.set('task', options.task);
  if (options.date) params.set('date', options.date);
  params.set('workstation', options.workstation);

  const url = `${options.apiUrl}/recall?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      'x-api-key': options.apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Recall failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<RecallResponse>;
}

function extractPreference(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed.preference || parsed.text || parsed.summary || content;
    }
  } catch {
    // not JSON, use as-is
  }
  return content;
}

function formatEpisode(content: string): string {
  try {
    const ep = JSON.parse(content);
    if (typeof ep !== 'object' || ep === null) return content;

    const lines: string[] = [];

    if (ep.title) {
      lines.push(`### ${ep.title}`);
    } else if (ep.situation) {
      lines.push(`### ${ep.situation.length > 100 ? ep.situation.slice(0, 100) + '...' : ep.situation}`);
    }

    if (ep.situation) lines.push(`**Situation:** ${ep.situation}`);
    if (ep.intent) lines.push(`**Intent:** ${ep.intent}`);
    if (ep.use_cases) lines.push(`**Use cases:** ${ep.use_cases}`);
    if (ep.hints) lines.push(`**Hints:** ${ep.hints}`);
    if (ep.assessment) lines.push(`**Assessment:** ${ep.assessment}`);
    if (ep.justification) lines.push(`**Justification:** ${ep.justification}`);
    if (ep.reflection) lines.push(`**Reflection:** ${ep.reflection}`);
    if (ep.confidence) lines.push(`**Confidence:** ${ep.confidence}`);

    if (Array.isArray(ep.turns) && ep.turns.length > 0) {
      lines.push('', '**Turns:**');
      for (const turn of ep.turns) {
        if (turn.situation) lines.push(`- **Situation:** ${turn.situation}`);
        if (turn.intent) lines.push(`  **Intent:** ${turn.intent}`);
        if (turn.action) lines.push(`  **Action:** ${turn.action}`);
        if (turn.thought) lines.push(`  **Thought:** ${turn.thought}`);
        if (turn.assessmentAssistant) lines.push(`  **Assessment (assistant):** ${turn.assessmentAssistant}`);
        if (turn.assessmentUser) lines.push(`  **Assessment (user):** ${turn.assessmentUser}`);
      }
    }

    return lines.join('\n');
  } catch {
    return content;
  }
}

function formatBulletSection(title: string, records: MemoryRecord[], extractor: (c: string) => string): string {
  if (records.length === 0) return '';
  const items = records.map((r) => `- ${extractor(r.content)}`).join('\n');
  return `## ${title}\n${items}\n`;
}

function formatEpisodeSection(records: MemoryRecord[]): string {
  if (records.length === 0) return '';
  const items = records.map((r) => formatEpisode(r.content)).join('\n\n');
  return `## Episodes\n${items}\n`;
}

export interface FormatOptions {
  visible: boolean;
}

export function formatRecallOutput(response: RecallResponse, visibleOrOpts: boolean | FormatOptions): string {
  const opts: FormatOptions = typeof visibleOrOpts === 'boolean'
    ? { visible: visibleOrOpts }
    : visibleOrOpts;
  const visible = opts.visible;

  const sections: string[] = [];

  if (response.about && response.about.length > 0) {
    const bio = response.about.map((r) => r.content).join('\n\n');
    sections.push(`## About\n${bio}\n`);
  }
  if (response.preferences) {
    sections.push(formatBulletSection('Preferences', response.preferences, extractPreference));
  }
  if (response.facts) {
    sections.push(formatBulletSection('Facts', response.facts, (c) => c));
  }
  if (response.episodes) {
    sections.push(formatEpisodeSection(response.episodes));
  }

  if (response.project) {
    sections.push(formatBulletSection(`Project: ${response.project.name}`, response.project.memories, (c) => c));
  }

  if (response.tasks) {
    sections.push(formatBulletSection(`Task: ${response.tasks.name}`, response.tasks.memories, (c) => c));
  }

  if (response.daily) {
    sections.push(formatBulletSection(`Daily: ${response.daily.date}`, response.daily.memories, (c) => c));
  }

  const content = sections.filter(Boolean).join('\n');

  if (!content) return '';

  if (visible) {
    return `# mnemo — recalled memories\n\n${content}`;
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `[mnemo context]\n${content}`,
    },
  });
}
