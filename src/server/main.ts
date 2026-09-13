import { ConfigError, loadConfig, type Config } from './config.js';
import { createLogger } from './logger.js';
import { startService } from './service.js';
import { createShutdown } from './shutdown.js';

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel);
  // Installed before startService, so a signal during start-up stops the service as soon as it is up.
  const shutdown = createShutdown({ logger, exit: (code) => process.exit(code) });
  process.on('SIGTERM', shutdown.handle);
  process.on('SIGINT', shutdown.handle);
  shutdown.attach(await startService(config, logger));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
