// SPDX-License-Identifier: MPL-2.0
import { createRuntime } from './runtime.js';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.PORT || 3300);
const runtime = await createRuntime({ port, origin: process.env.PUBLIC_ORIGIN || `http://localhost:${port}`,
  demoOrigin: process.env.DEMO_ORIGIN || `http://localhost:${port}`, persistence: fileURLToPath(new URL('.data', import.meta.url)), invite: process.env.SETUP_INVITE || 'local-development-only' });
console.log(`Roundhouse local fixture runtime ready on port ${port}; live provider disabled`);
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await runtime.close(); process.exit(0); });
