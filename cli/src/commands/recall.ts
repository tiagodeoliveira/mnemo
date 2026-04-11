export interface RecallOptions {
  apiUrl: string;
  apiKey: string;
  project?: string;
  workstation: string;
}

interface MemoryRecord {
  id: string;
  content: string;
  score: number;
  createdAt: string;
}

interface RecallResponse {
  preferences: MemoryRecord[];
  facts: MemoryRecord[];
  episodes: MemoryRecord[];
  project?: {
    name: string;
    memories: MemoryRecord[];
  };
}

export async function executeRecall(options: RecallOptions): Promise<RecallResponse> {
  const params = new URLSearchParams();
  if (options.project) params.set('project', options.project);
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

export function formatRecallOutput(response: RecallResponse, visible: boolean): string {
  const sections: string[] = [];

  sections.push(formatBulletSection('Preferences', response.preferences, extractPreference));
  sections.push(formatBulletSection('Facts', response.facts, (c) => c));
  sections.push(formatEpisodeSection(response.episodes));

  if (response.project) {
    sections.push(formatBulletSection(`Project: ${response.project.name}`, response.project.memories, (c) => c));
  }

  const content = sections.filter(Boolean).join('\n');

  if (!content) return '';

  if (visible) {
    return `# mnemo — recalled memories\n\n${content}`;
  }

  return JSON.stringify({
    continue: true,
    suppressOutput: true,
    systemMessage: `[mnemo context]\n${content}`,
  });
}
