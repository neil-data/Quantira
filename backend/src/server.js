import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { connectDB, connectRedis } from './config/database.js';
import { ingestionRouter } from './routes/ingestion.js';
import { queueEvents } from './jobs/ingestionQueue.js';
import { logger } from './utils/logger.js';
import { mkdirSync } from 'fs';

// Ensure storage dirs exist
['./storage/pdfs', './storage/reports', './logs'].forEach(dir => {
  mkdirSync(dir, { recursive: true });
});

const app = express();
const server = createServer(app);

// ── Middleware ───────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined', { stream: { write: msg => logger.http(msg.trim()) } }));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/ingest', ingestionRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── WebSocket — live job progress ─────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// Map jobId → Set of connected WebSocket clients
const jobSubscribers = new Map();

wss.on('connection', (ws) => {
  let subscribedJobId = null;

  ws.on('message', (msg) => {
    try {
      const { type, jobId } = JSON.parse(msg);
      if (type === 'subscribe' && jobId) {
        subscribedJobId = jobId;
        if (!jobSubscribers.has(jobId)) jobSubscribers.set(jobId, new Set());
        jobSubscribers.get(jobId).add(ws);
        ws.send(JSON.stringify({ type: 'subscribed', jobId }));
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    if (subscribedJobId) {
      jobSubscribers.get(subscribedJobId)?.delete(ws);
    }
  });
});

// Forward BullMQ progress events to WebSocket subscribers
queueEvents.on('progress', ({ jobId, data }) => {
  const subscribers = jobSubscribers.get(jobId);
  if (!subscribers?.size) return;

  const msg = JSON.stringify({ type: 'progress', jobId, ...data });
  for (const ws of subscribers) {
    if (ws.readyState === 1) ws.send(msg);  // 1 = OPEN
  }
});

queueEvents.on('completed', ({ jobId, returnvalue }) => {
  const subscribers = jobSubscribers.get(jobId);
  if (!subscribers?.size) return;

  const msg = JSON.stringify({ type: 'completed', jobId, result: returnvalue });
  for (const ws of subscribers) {
    if (ws.readyState === 1) ws.send(msg);
  }
  // Clean up after a delay
  setTimeout(() => jobSubscribers.delete(jobId), 30000);
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  const subscribers = jobSubscribers.get(jobId);
  if (!subscribers?.size) return;

  const msg = JSON.stringify({ type: 'failed', jobId, error: failedReason });
  for (const ws of subscribers) {
    if (ws.readyState === 1) ws.send(msg);
  }
  setTimeout(() => jobSubscribers.delete(jobId), 10000);
});

// ── Boot ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

await connectDB();
await connectRedis();

server.listen(PORT, () => {
  logger.info(`Quantira server running on port ${PORT}`);
  logger.info(`WebSocket available at ws://localhost:${PORT}/ws`);
});

export default app;