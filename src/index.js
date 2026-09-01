#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, SERVER_NAME, VERSION } from './config.js';
import { buildServer } from './server.js';

async function main() {
  const config = loadConfig();
  await mkdir(config.cacheDir, { recursive: true });
  const server = buildServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] v${VERSION} ready (local-only; cache: ${config.cacheDir})`);
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] fatal:`, error);
  process.exit(1);
});
