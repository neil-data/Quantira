/**
 * Ingestion Orchestrator — Day 1 pipeline
 * 1) Discover annual report PDFs from exchange sources
 * 2) Download + cache PDFs
 * 3) Store raw PDFs in GridFS
 * 4) Parse PDFs to structured JSON
 * 5) Persist per-year financials in MongoDB
 */

import { Company, Filing, FinancialData } from '../models/index.js';
import { searchCompanyBSE, getAnnualReportsBSE } from './bseScraper.js';
import { searchCompanyNSE, getAnnualReportsNSE } from './nseScraper.js';
import { scrapeScreener, searchScreener } from './screenerScraper.js';
import { getPDFPath, downloadPDF, uploadPDFToGridFS } from './pdfDownloader.js';
import { parsePDF } from './pdfParser.js';
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
    extractionWarnings: ['Fallback source used for this year']
  };
}

async function resolveCompany(query) {
  const [bse, nse, screener] = await Promise.allSettled([
    searchCompanyBSE(query),
    searchCompanyNSE(query),
    searchScreener(query)
  ]);

  const bseResults = bse.status === 'fulfilled' ? bse.value : [];
  const nseResults = nse.status === 'fulfilled' ? nse.value : [];
  const screenerResults = screener.status === 'fulfilled' ? screener.value : [];

  const bseTop = bseResults[0] || {};
  const nseTop = nseResults[0] || {};
  const screenerTop = screenerResults[0] || {};

  const nseSymbol = nseTop.nseSymbol || bseTop.nseSymbol || screenerTop.symbol || query.toUpperCase();
  const name = bseTop.name || nseTop.name || screenerTop.name || query;

  return {
    name,
    nseSymbol,
    bseCode: bseTop.bseCode || null,
    industry: bseTop.industry || null,
    sector: bseTop.sector || null
  };
}

async function discoverAnnualReportFilings(companyInfo) {
  const filings = [];

  if (companyInfo.bseCode) {
    const bseFilings = await getAnnualReportsBSE(companyInfo.bseCode, FROM_YEAR);
    filings.push(...bseFilings.map(f => ({ ...f, source: 'BSE' })));
  }

  if (companyInfo.nseSymbol) {
    const nseFilings = await getAnnualReportsNSE(companyInfo.nseSymbol, FROM_YEAR);
    filings.push(...nseFilings.map(f => ({ ...f, source: 'NSE' })));
  }

  const deduped = new Map();
  for (const filing of filings) {
    if (!filing.year || !filing.pdfUrl) continue;

    const key = String(filing.year);
    if (!deduped.has(key)) {
      deduped.set(key, filing);
      continue;
    }

    const existing = deduped.get(key);
    if (existing.source !== 'BSE' && filing.source === 'BSE') {
      deduped.set(key, filing);
    }
  }

  return Array.from(deduped.values())
    .filter(f => f.year >= FROM_YEAR)
    .sort((a, b) => a.year - b.year);
}

async function processPdfFiling(company, filingMeta) {
  const filing = await Filing.findOneAndUpdate(
    {
      companyId: company._id,
      year: filingMeta.year,
      filingType: 'annual_report'
    },
    {
      $set: {
        source: filingMeta.source,
        sourceUrl: filingMeta.pdfUrl,
        parseStatus: 'parsing'
      },
      $setOnInsert: {
        cin: company.cin || null
      }
    },
    { upsert: true, new: true }
  );

  try {
    const sourceSuffix = filingMeta.source.toLowerCase();
    const pdfPath = getPDFPath(company._id, filingMeta.year, sourceSuffix);
    const { pdfPath: localPdfPath, size } = await downloadPDF(filingMeta.pdfUrl, pdfPath);

    const gridFsFileId = await uploadPDFToGridFS(localPdfPath, {
      companyId: company._id.toString(),
      filingId: filing._id.toString(),
      year: filingMeta.year,
      source: filingMeta.source,
      sourceUrl: filingMeta.pdfUrl
    });

    const parsed = await parsePDF(localPdfPath);

    const relatedRevenue = (parsed.relatedPartyTransactions || [])
      .filter(txn => txn.transactionType === 'sale')
      .reduce((sum, txn) => sum + (txn.amount || 0), 0);
    const relatedExpenses = (parsed.relatedPartyTransactions || [])
      .filter(txn => txn.transactionType === 'purchase')
      .reduce((sum, txn) => sum + (txn.amount || 0), 0);

    const financialDoc = {
      companyId: company._id,
      filingId: filing._id,
      year: filingMeta.year,
      balanceSheet: parsed.balanceSheet,
      pnl: {
        ...parsed.pnl,
        relatedPartyRevenue: relatedRevenue || null,
        relatedPartyExpenses: relatedExpenses || null
      },
      cashFlow: parsed.cashFlow,
      auditorInfo: parsed.auditorInfo,
      relatedPartyTransactions: parsed.relatedPartyTransactions || [],
      rawSections: parsed.rawSections,
      extractionConfidence: parsed.extractionConfidence,
      extractionWarnings: parsed.extractionWarnings || []
    };

    await FinancialData.findOneAndUpdate(
      { companyId: company._id, year: filingMeta.year },
      { $set: financialDoc },
      { upsert: true, new: true }
    );

    await Filing.findByIdAndUpdate(filing._id, {
      parseStatus: 'parsed',
      parsedAt: new Date(),
      pdfPath: localPdfPath,
      pdfSize: size,
      gridFsFileId
    });

    return filingMeta.year;
  } catch (error) {
    await Filing.findByIdAndUpdate(filing._id, {
      parseStatus: 'failed',
      parseError: error.message
    });
    throw error;
  }
}

async function fillMissingYearsFromFallback(company, companyInfo, existingYearsSet) {
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
          source: 'manual',
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
  if (!companyInfo?.nseSymbol && !companyInfo?.bseCode) {
    throw new Error(`Company not found for query: ${query}`);
  }

  const company = await Company.findOneAndUpdate(
    {
      $or: [
        { nseSymbol: companyInfo.nseSymbol },
        { bseCode: companyInfo.bseCode },
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
        pdfYears: cached.pdfYears || [],
        fallbackYears: cached.fallbackYears || []
      }
    };
  }

  onProgress('discovery', 15, 'Discovering annual report PDFs from exchange sources...');
  const filings = await discoverAnnualReportFilings(companyInfo);
  logger.info('Discovered annual report filings', {
    query,
    discovered: filings.length,
    years: filings.map(f => f.year)
  });

  const yearsProcessed = new Set();
  const pdfYears = new Set();
  const fallbackYears = new Set();
  const total = Math.max(filings.length, 1);

  for (let i = 0; i < filings.length; i++) {
    const filingMeta = filings[i];
    const pct = 20 + Math.floor(((i + 1) / total) * 55);
    onProgress('ingesting', pct, `Processing annual report FY${filingMeta.year} (${filingMeta.source})...`);

    try {
      const year = await processPdfFiling(company, filingMeta);
      yearsProcessed.add(year);
      pdfYears.add(year);
    } catch (error) {
      logger.warn('Failed PDF pipeline for year, will attempt fallback later', {
        year: filingMeta.year,
        source: filingMeta.source,
        error: error.message
      });
    }
  }

  if (yearsProcessed.size < YEARS_TO_FETCH) {
    onProgress('ingesting', 80, 'Filling missing years using fallback source...');
    try {
      const fallbackYearsFromSource = await fillMissingYearsFromFallback(company, companyInfo, yearsProcessed);
      fallbackYearsFromSource.forEach(y => {
        yearsProcessed.add(y);
        fallbackYears.add(y);
      });
    } catch (error) {
      logger.warn('Fallback ingestion failed', { error: error.message });
    }
  }

  const yearsArray = Array.from(yearsProcessed).sort((a, b) => a - b);
  const pdfYearsArray = Array.from(pdfYears).sort((a, b) => a - b);
  const fallbackYearsArray = Array.from(fallbackYears).sort((a, b) => a - b);

  await Company.findByIdAndUpdate(company._id, {
    ingestStatus: yearsArray.length >= YEARS_TO_FETCH && pdfYearsArray.length > 0 ? 'complete' : 'partial',
    lastIngested: new Date(),
    yearsAvailable: yearsArray,
    filingCount: yearsArray.length
  });

  await cache.set(cacheKey, {
    complete: yearsArray.length >= YEARS_TO_FETCH && pdfYearsArray.length > 0,
    years: yearsArray,
    pdfYears: pdfYearsArray,
    fallbackYears: fallbackYearsArray
  });

  onProgress('complete', 100, `Ingestion complete — ${yearsArray.length} years processed`);
  return {
    companyId: company._id,
    yearsProcessed: yearsArray,
    fromCache: false,
    sourceCoverage: {
      pdfYears: pdfYearsArray,
      fallbackYears: fallbackYearsArray
    }
  };
}

export async function getCompanyFinancials(companyId) {
  return FinancialData.find({ companyId }).sort({ year: 1 }).lean();
}

export async function searchLocalCompanies(query) {
  return Company.find({ $text: { $search: query } }).limit(10).lean();
}