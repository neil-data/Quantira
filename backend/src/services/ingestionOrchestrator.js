/**
 * Ingestion Orchestrator — Day 1 pipeline
 * Data source: Screener.in (structured financial data)
 *
 * TODO: BSE/NSE official API integration (future)
 * TODO: PDF annual report parsing (future)
 */

import { Company, Filing, FinancialData } from '../models/index.js';
import { scrapeScreener, searchScreener } from './screenerScraper.js';
import { cache } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { normalizeCompanyName } from '../utils/helpers.js';

const YEARS_TO_FETCH = 10;
const CURRENT_YEAR = new Date().getFullYear();
const FROM_YEAR = CURRENT_YEAR - YEARS_TO_FETCH;

function mapScreenerToSchema(record) {
  const ebit = record.ebit ??
    (record.operatingProfit != null && record.depreciation != null
      ? record.operatingProfit - record.depreciation
      : null);

  const transactions = [];
  if (record.relatedPartyRevenue) {
    transactions.push({
      party: 'Related Parties',
      transactionType: 'sale',
      amount: record.relatedPartyRevenue,
      year: record.year,
      lineRef: 'Screener derived'
    });
  }
  if (record.relatedPartyExpenses) {
    transactions.push({
      party: 'Related Parties',
      transactionType: 'purchase',
      amount: record.relatedPartyExpenses,
      year: record.year,
      lineRef: 'Screener derived'
    });
  }

  return {
    year: record.year,
    extractionConfidence: 0.75,
    balanceSheet: {
      totalAssets: record.totalAssets ?? null,
      shareholdersEquity: record.totalEquity ?? null,
      totalDebt: record.totalDebt ?? null,
      cashAndEquivalents: record.cash ?? null,
      accountsReceivable: record.tradeReceivables ?? null,
      inventory: record.inventory ?? null,
      fixedAssets: record.fixedAssets ?? null,
      investments: record.investments ?? null,
      totalLiabilities: (record.totalAssets != null && record.totalEquity != null)
        ? record.totalAssets - record.totalEquity
        : null
    },
    pnl: {
      revenue: record.revenue ?? null,
      ebitda: record.operatingProfit ?? null,
      depreciation: record.depreciation ?? null,
      ebit,
      interestExpense: record.interestExpense ?? null,
      pbt: record.profitBeforeTax ?? null,
      taxExpense: record.tax ?? null,
      pat: record.netProfit ?? null,
      eps: record.eps ?? null,
      relatedPartyRevenue: record.relatedPartyRevenue ?? null,
      relatedPartyExpenses: record.relatedPartyExpenses ?? null
    },
    cashFlow: {
      operatingCashFlow: record.operatingCashFlow ?? null,
      investingCashFlow: record.investingCashFlow ?? null,
      financingCashFlow: record.financingCashFlow ?? null,
      capex: record.capex != null ? Math.abs(record.capex) : null,
      freeCashFlow: (record.operatingCashFlow != null && record.capex != null)
        ? record.operatingCashFlow - Math.abs(record.capex)
        : null
    },
    auditorInfo: {
      hedgingLanguage: [],
      keyAuditMatters: []
    },
    relatedPartyTransactions: transactions,
    extractionWarnings: ['Data sourced from Screener.in']
  };
}

async function resolveCompany(query) {
  const screenerResults = await searchScreener(query).catch(() => []);
  const screenerTop = screenerResults[0] || {};

  const nseSymbol = screenerTop.symbol || query.toUpperCase();
  const name = screenerTop.name || query;

  return {
    name,
    nseSymbol,
    bseCode: null,
    industry: null,
    sector: null
  };
}

async function fillYearsFromScreener(company, companyInfo, existingYearsSet) {
  const symbol = companyInfo.nseSymbol;
  if (!symbol) return [];

  const screenerRows = await scrapeScreener(symbol);
  const missing = screenerRows
    .filter(row => row.year >= FROM_YEAR && !existingYearsSet.has(row.year))
    .sort((a, b) => a.year - b.year);

  const addedYears = [];
  for (const row of missing) {
    const mapped = mapScreenerToSchema(row);

    const filing = await Filing.findOneAndUpdate(
      {
        companyId: company._id,
        year: row.year,
        filingType: 'annual_report'
      },
      {
        $set: {
          source: 'screener',
          sourceUrl: `https://www.screener.in/company/${symbol}/consolidated/`,
          parseStatus: 'parsed',
          parsedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    await FinancialData.findOneAndUpdate(
      { companyId: company._id, year: row.year },
      {
        $set: {
          companyId: company._id,
          filingId: filing._id,
          ...mapped
        }
      },
      { upsert: true, new: true }
    );

    addedYears.push(row.year);
  }

  return addedYears;
}

export async function ingestCompany(query, onProgress = () => {}, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  logger.info('Starting Day 1 ingestion pipeline', { query });
  onProgress('resolving', 5, `Resolving company identity for "${query}"...`);

  const companyInfo = await resolveCompany(query);
  if (!companyInfo?.nseSymbol) {
    throw new Error(`Company not found for query: ${query}`);
  }

  const company = await Company.findOneAndUpdate(
    {
      $or: [
        { nseSymbol: companyInfo.nseSymbol },
        { nameNormalized: normalizeCompanyName(companyInfo.name) }
      ]
    },
    {
      $set: {
        ...companyInfo,
        nameNormalized: normalizeCompanyName(companyInfo.name),
        ingestStatus: 'in_progress'
      }
    },
    { upsert: true, new: true }
  );

  const cacheKey = `ingested:${company._id}`;
  if (forceRefresh) {
    await cache.del(cacheKey);
  }

  const cached = forceRefresh ? null : await cache.get(cacheKey);
  if (!forceRefresh && cached?.complete && Array.isArray(cached.years) && cached.years.length >= YEARS_TO_FETCH) {
    onProgress('complete', 100, 'Using recently cached data');
    return {
      companyId: company._id,
      fromCache: true,
      yearsProcessed: cached.years,
      sourceCoverage: {
        screenerYears: cached.screenerYears || []
      }
    };
  }

  onProgress('ingesting', 20, `Fetching ${YEARS_TO_FETCH} years of financials from Screener.in...`);

  const yearsProcessed = new Set();
  const screenerYears = new Set();

  try {
    const addedYears = await fillYearsFromScreener(company, companyInfo, yearsProcessed);
    addedYears.forEach(y => {
      yearsProcessed.add(y);
      screenerYears.add(y);
    });
  } catch (error) {
    logger.warn('Screener ingestion failed', { error: error.message });
  }

  const yearsArray = Array.from(yearsProcessed).sort((a, b) => a - b);
  const screenerYearsArray = Array.from(screenerYears).sort((a, b) => a - b);

  await Company.findByIdAndUpdate(company._id, {
    ingestStatus: yearsArray.length >= YEARS_TO_FETCH ? 'complete' : 'partial',
    lastIngested: new Date(),
    yearsAvailable: yearsArray,
    filingCount: yearsArray.length
  });

  await cache.set(cacheKey, {
    complete: yearsArray.length >= YEARS_TO_FETCH,
    years: yearsArray,
    screenerYears: screenerYearsArray
  });

  onProgress('complete', 100, `Ingestion complete — ${yearsArray.length} years processed`);
  return {
    companyId: company._id,
    yearsProcessed: yearsArray,
    fromCache: false,
    sourceCoverage: {
      screenerYears: screenerYearsArray
    }
  };
}

export async function getCompanyFinancials(companyId) {
  return FinancialData.find({ companyId }).sort({ year: 1 }).lean();
}

export async function searchLocalCompanies(query) {
  return Company.find({ $text: { $search: query } }).limit(10).lean();
}
