/**
 * Job Queue — BullMQ backed by Redis
 * Handles ingestion jobs asynchronously
 * Emits progress events that the WebSocket layer subscribes to
 */
 
import { Queue, Worker, QueueEvents } from 'bullmq';
import { EventEmitter } from 'events';
import { ingestCompany } from '../services/ingestionOrchestrator.js';
import { runAnomalyEngine } from '../services/anomalyEngine.js';
import { logger } from '../utils/logger.js';
 
// Parse REDIS_URL for BullMQ connection config
function getRedisConnection() {
  const url = process.env.REDIS_URL;
 
  if (!url) {
    logger.warn('REDIS_URL not set — BullMQ will be disabled');
    return null;
  }
 
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379'),
      username: parsed.username || 'default',
      password: parsed.password || undefined,
      tls: url.startsWith('rediss://') ? {} : undefined,
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
      enableReadyCheck: false,
      retryStrategy: (times) => {
        if (times > 3) {
          logger.warn('BullMQ Redis retry limit reached; queue features may be unavailable');
          return null;
        }
        return Math.min(times * 400, 2000);
      }
    };
  } catch {
    logger.error('Invalid REDIS_URL format');
    return null;
  }
}
 
const useRedisQueue = process.env.REQUIRE_REDIS === 'true';
const redisConn = useRedisQueue ? getRedisConnection() : null;
const queueReady = useRedisQueue && redisConn !== null;
 
// ── Queues ────────────────────────────────────────────────────────────────
export const ingestionQueue = queueReady
  ? new Queue('ingestion', {
      connection: redisConn,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 50,
        timeout: parseInt(process.env.JOB_TIMEOUT_MS || '120000')
      }
    })
  : {
      async getWaitingCount() { return 0; },
      async getActiveCount() { return 0; },
      async getCompletedCount() { return 0; },
      async getFailedCount() { return 0; },
      async getJob() { return null; }
    };
 
export const queueEvents = queueReady
  ? new QueueEvents('ingestion', { connection: redisConn })
  : new EventEmitter();
 
// ── Worker ────────────────────────────────────────────────────────────────
export function startWorker() {
  if (!queueReady) {
    logger.warn('Worker is disabled because REQUIRE_REDIS is not true or REDIS_URL is missing');
    return { async close() {} };
  }
 
  const worker = new Worker('ingestion', async (job) => {
    logger.info('Processing ingestion job', { jobId: job.id, query: job.data.query });
 
    const { query, forceRefresh = false } = job.data;
 
    const onProgress = async (stage, percent, message) => {
      await job.updateProgress({ stage, percent, message });
      logger.debug('Job progress', { jobId: job.id, stage, percent, message });
    };
 
    const ingestionResult = await ingestCompany(query, onProgress, { forceRefresh });
 
    onProgress('analyzing', 82, 'Running fraud pattern analysis...');
    await runAnomalyEngine(ingestionResult.companyId, onProgress);
 
    onProgress('complete', 100, 'Analysis complete — report ready');
    return ingestionResult;
  }, {
    connection: redisConn,
    concurrency: 3,
    limiter: {
      max: 5,
      duration: 60000
    }
  });
 
  worker.on('completed', (job) => {
    logger.info('Job completed', { jobId: job.id, company: job.data.query });
  });
 
  worker.on('failed', (job, err) => {
    logger.error('Job failed', { jobId: job?.id, error: err.message });
  });
 
  worker.on('progress', (job, progress) => {
    logger.debug('Job progress update', { jobId: job.id, progress });
  });
 
  logger.info('Ingestion worker started');
  return worker;
}
 
/**
 * Add a company ingestion job to the queue
 */
export async function queueIngestion(query, options = {}) {
  if (!queueReady) {
    throw new Error('Queue is disabled. Set REQUIRE_REDIS=true and a valid REDIS_URL to enable ingestion jobs.');
  }
 
  const job = await ingestionQueue.add('ingest', {
    query,
    forceRefresh: options.forceRefresh === true,
    queuedAt: new Date().toISOString()
  }, {
    jobId: `ingest-${query.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`
  });
 
  logger.info('Queued ingestion job', { jobId: job.id, query });
  return job.id;
}
 
/**
 * Get job status for polling / WebSocket
 */
export async function getJobStatus(jobId) {
  const job = await ingestionQueue.getJob(jobId);
  if (!job) return null;
 
  const state = await job.getState();
  const progress = job.progress || {};
 
  return {
    jobId,
    state,
    progress: typeof progress === 'object' ? progress : { percent: progress },
    result: job.returnvalue,
    failedReason: job.failedReason
  };
}