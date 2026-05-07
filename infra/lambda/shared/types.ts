export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface EventContext {
  project?: string;
  workstation: string;
  workdir: string;
  timestamp: string;
  date?: string;
  source?: string;
  attributes?: Record<string, string>;
}

export interface IngestRequest {
  sessionId: string;
  turns: Turn[];
  context: EventContext;
}

export interface MemoryRecord {
  id: string;
  content: string;
  score: number;
  createdAt: string;
}

export interface RecallResponse {
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
