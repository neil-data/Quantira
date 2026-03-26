/**
 * Pre-seed script — run BEFORE the hackathon demo
 * Ingests the 10 companies judges are most likely to ask about
 * Run: npm run seed-peers
 */

import 'dotenv/config';
import { connectDB } from '../config/database.js';
import { ingestCompany } from '../services/ingestionOrchestrator.js';
import { logger } from '../utils/logger.js';

// Famous companies judges will likely test with
const SEED_COMPANIES = [
  // Red flag hall of fame
  { query: 'SATYAMCOMP', note: 'Satyam — the canonical fraud case' },
  { query: 'YESBANK', note: 'Yes Bank collapse' },
  // Blue chips for comparison
  { query: 'INFY', note: 'Infosys — clean benchmark' },
  { query: 'TCS', note: 'TCS — clean benchmark' },
  { query: 'RELIANCE', note: 'Reliance — large conglomerate' },
  { query: 'HDFCBANK', note: 'HDFC Bank — BFSI benchmark' },
  // NBFC sector (IL&FS peer)
  { query: 'BAJFINANCE', note: 'Bajaj Finance — NBFC comparison' },
  // Construction
  { query: 'DLF', note: 'DLF — construction benchmark' },
  // Pharma
  { query: 'SUNPHARMA', note: 'Sun Pharma — pharma benchmark' },
  { query: 'DRREDDY', note: 'Dr Reddy — pharma benchmark' }
];

await connectDB();

logger.info(`Starting seed for ${SEED_COMPANIES.length} companies...`);

for (const { query, note } of SEED_COMPANIES) {
  logger.info(`Seeding: ${query} — ${note}`);
  try {
    const result = await ingestCompany(query, (stage, pct, msg) => {
      logger.info(`  [${query}] ${stage} ${pct}% — ${msg}`);
    });
    logger.info(`  ✓ ${query} complete — ${result.yearsProcessed?.length || 0} years`);
  } catch (err) {
    logger.error(`  ✗ ${query} failed: ${err.message}`);
  }
  // Polite delay between companies
  await new Promise(r => setTimeout(r, 3000));
}

logger.info('Seed complete!');
process.exit(0);