import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';
import { openDatabase } from './database.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = createApp({
  db,
  config,
  publicDir: path.join(serverRoot, 'public'),
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`license server listening on http://0.0.0.0:${config.port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
