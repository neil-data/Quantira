import { Router } from 'express';
import { queueIngestion, getJobStatus, ingestionQueue } from '../jobs/ingestionQueue.js';
import { Company, FinancialData } from '../models/index.js';
import { searchLocalCompanies } from '../services/ingestionOrchestrator.js';
import { cache } from '../config/database.js';
import { logger } from '../utils/logger.js';

export const ingestionRouter = Router();

/**
 * POST /api/ingest
 * Start ingestion for a company
 * Body: { query: "Infosys" | "INFY" | "500209" }
 */
ingestionRouter.post('/', async (req, res) => {
  const { query, forceRefresh = false } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'query must be a company name, NSE symbol, or BSE code' });
  }

  try {
    // Check if we have recent data already
    const existing = await Company.findOne({
      $or: [
        { nameNormalized: query.toLowerCase() },
        { nseSymbol: query.toUpperCase() },
        { bseCode: query }
      ],
      ingestStatus: 'complete',
      lastIngested: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    if (existing && forceRefresh !== true) {
      return res.json({
        jobId: null,
        companyId: existing._id,
        fromCache: true,
        message: 'Using recently cached data'
      });
    }

    const jobId = await queueIngestion(query.trim(), { forceRefresh });
    res.json({ jobId, message: 'Ingestion started' });
  } catch (err) {
    logger.error('Ingestion request failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ingest/status/:jobId
 * Poll job status
 */
ingestionRouter.get('/status/:jobId', async (req, res) => {
  try {
    const status = await getJobStatus(req.params.jobId);
    if (!status) return res.status(404).json({ error: 'Job not found' });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ingest/search?q=infosys
 * Search companies (local DB first, then suggest live search)
 */
ingestionRouter.get('/search', async (req, res) => {
  const q = req.query.q?.toString().trim();
  if (!q || q.length < 2) return res.json([]);

  try {
    const local = await searchLocalCompanies(q);
    res.json(local.map(c => ({
      id: c._id,
      name: c.name,
      nseSymbol: c.nseSymbol,
      bseCode: c.bseCode,
      industry: c.industry,
      yearsAvailable: c.yearsAvailable,
      lastIngested: c.lastIngested
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ingest/company/:companyId/financials
 * Get all years of financial data for a company
 */
ingestionRouter.get('/company/:companyId/financials', async (req, res) => {
  try {
    const data = await FinancialData.find({ companyId: req.params.companyId })
      .sort({ year: 1 })
      .lean();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ingest/queue-stats
 * Queue health — useful for the demo
 */
ingestionRouter.get('/queue-stats', async (req, res) => {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      ingestionQueue.getWaitingCount(),
      ingestionQueue.getActiveCount(),
      ingestionQueue.getCompletedCount(),
      ingestionQueue.getFailedCount()
    ]);
    res.json({ waiting, active, completed, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});