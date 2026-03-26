import mongoose from 'mongoose';
import { Redis } from '@upstash/redis';
import { logger } from '../utils/logger.js';

const shouldRequireDb = process.env.REQUIRE_DB === 'true';
const shouldRequireRedis = process.env.REQUIRE_REDIS === 'true';

let redisConnected = false;
let redisDisabled = false;
const memoryCache = new Map();
let gridFSBucket = null;

// ── MongoDB connection ──
export async function connectDB() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    const msg = 'MONGODB_URI is not set. Running without MongoDB.';
    if (shouldRequireDb) throw new Error(msg);
    logger.warn(msg);
    return false;
  }

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000
    });
    gridFSBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'annualReports'
    });
    logger.info('MongoDB connected');
    return true;
  } catch (err) {
    const message = err?.message || String(err);
    logger.error(`MongoDB connection failed: ${message}`);
    if (shouldRequireDb) {
      throw err;
    }
    logger.warn('Continuing without MongoDB because REQUIRE_DB is not true');
    return false;
  }
}

export function getGridFSBucket() {
  return gridFSBucket;
}

// ── Upstash Redis client (REST-based, no raw TCP connection) ──
let _redisClient = null;

function createRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    logger.warn('Upstash Redis credentials not set (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
    return null;
  }

  try {
    const client = new Redis({ url, token });
    logger.info('Upstash Redis client created');
    return client;
  } catch (err) {
    const message = err?.message || String(err);
    logger.error(`Failed to create Redis client: ${message}`);
    return null;
  }
}

// Exported so other files can import it — but prefer using cache helpers below
export const redisClient = {
  get client() { return _redisClient; }
};

export async function connectRedis() {
  if (redisDisabled) return false;

  _redisClient = createRedisClient();

  if (!_redisClient) {
    redisDisabled = true;
    if (shouldRequireRedis) throw new Error('Redis client could not be created');
    logger.warn('Continuing without Redis because REQUIRE_REDIS is not true');
    return false;
  }

  try {
    // Upstash is HTTP-based — ping to verify credentials work
    await _redisClient.ping();
    redisConnected = true;
    logger.info('Redis connected (Upstash)');
    return true;
  } catch (err) {
    const message = err?.message || String(err);
    logger.error(`Redis connection failed: ${message}`);
    redisDisabled = true;
    redisConnected = false;
    _redisClient = null;
    if (shouldRequireRedis) throw err;
    logger.warn('Continuing without Redis because REQUIRE_REDIS is not true');
    return false;
  }
}

// ── Simple in-memory + Redis cache helper ──
export const cache = {
  async get(key) {
    if (!redisConnected || !_redisClient) {
      return memoryCache.get(`quantira:${key}`) ?? null;
    }

    try {
      const val = await _redisClient.get(`quantira:${key}`);
      return val ? JSON.parse(val) : null;
    } catch {
      return memoryCache.get(`quantira:${key}`) ?? null;
    }
  },

  async set(key, value, ttlSeconds = parseInt(process.env.CACHE_TTL || '86400')) {
    const cacheKey = `quantira:${key}`;

    if (!redisConnected || !_redisClient) {
      memoryCache.set(cacheKey, value);
      if (ttlSeconds > 0) {
        setTimeout(() => memoryCache.delete(cacheKey), ttlSeconds * 1000).unref();
      }
      return;
    }

    try {
      await _redisClient.setex(cacheKey, ttlSeconds, JSON.stringify(value));
    } catch (err) {
      const message = err?.message || String(err);
      logger.warn(`Cache set failed: ${message}`);
      memoryCache.set(cacheKey, value);
    }
  },

  async del(key) {
    const cacheKey = `quantira:${key}`;
    memoryCache.delete(cacheKey);

    if (!redisConnected || !_redisClient) return;

    try {
      await _redisClient.del(cacheKey);
    } catch { /* ignore */ }
  }
};