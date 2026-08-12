import { assertProductionConfig, config } from './config.js';
import { SgfBot } from './bot.js';
import { startServer } from './server.js';
import { closeDatabase } from './db.js';
import { cache } from './cache.js';

assertProductionConfig();

const bot = new SgfBot();
await startServer(bot);
await bot.start();

const shutdown = async (signal: string) => {
  console.log(`[app] ${signal} received, shutting down`);
  bot.client.destroy();
  await Promise.allSettled([closeDatabase(), cache.close()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

console.log(`[app] mode=${config.nodeEnv}, publicUrl=${config.publicUrl}`);
