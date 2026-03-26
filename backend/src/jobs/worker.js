import 'dotenv/config';
import { connectDB, connectRedis } from '../config/database.js';
import { startWorker } from './ingestionQueue.js';
import { logger } from '../utils/logger.js';

await connectDB();
await connectRedis();
const worker = startWorker();

logger.info('Worker process started — waiting for jobs');

process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});