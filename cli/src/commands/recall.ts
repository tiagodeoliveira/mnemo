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

function formatSection(title: string, records: MemoryRecord[]): string {
  if (records.length === 0) return '';
  const items = records.map((r) => `- ${r.content}`).join('\n');
  return `## ${title}\n${items}\n`;
}

export function formatRecallOutput(response: RecallResponse, visible: boolean): string {
  const sections: string[] = [];

  sections.push(formatSection('Preferences', response.preferences));
  sections.push(formatSection('Facts', response.facts));
  sections.push(formatSection('Episodes', response.episodes));

  if (response.project) {
    sections.push(formatSection(`Project: ${response.project.name}`, response.project.memories));
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
