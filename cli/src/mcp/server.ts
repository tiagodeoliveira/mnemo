import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MnemoApi } from './handlers';
import { makeTools } from './handlers';

export function createServer(api: MnemoApi): McpServer {
  const server = new McpServer({ name: 'mnemo-mcp', version: '0.1.0' });
  for (const tool of makeTools(api)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args) => {
        const result = await tool.handler(args as Record<string, unknown>);
        return { ...result };
      },
    );
  }
  return server;
}
