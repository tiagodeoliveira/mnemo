export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface EventContext {
  project?: string;
  workstation: string;
  workdir: string;
  timestamp: string;
  source?: string;
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
  preferences: MemoryRecord[];
  facts: MemoryRecord[];
  episodes: MemoryRecord[];
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

export interface MemoryProviderProperties {
  memoryName: string;
  description: string;
  actorId: string;
  eventExpiryDuration: number;
  strategies: MemoryStrategyConfig;
}

export interface MemoryStrategyConfig {
  userPreference: {
    name: string;
    namespaceTemplates: string[];
  };
  semantic: {
    name: string;
    namespaceTemplates: string[];
  };
  episodic: {
    name: string;
    namespaceTemplates: string[];
    reflectionNamespaceTemplates: string[];
  };
  projectContext: {
    name: string;
    triggerMessageCount: number;
    idleSessionTimeout: number;
    snsTopicArn: string;
    s3BucketName: string;
    historicalContextWindowSize: number;
  };
}
