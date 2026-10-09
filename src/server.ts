import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { AttributionStore } from './store.ts';

const port = Number(process.env.PORT ?? 3000);
const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const databasePath = process.env.DATABASE_PATH ?? './data/attribution.sqlite';
const store = new AttributionStore(databasePath);
const app = createApp(store, baseUrl);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Attribution API listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    store.close();
    process.exit(0);
  });
}
