/**
 * Screener.in scraper
 * Extracts 10 years of structured financial data directly from HTML tables
 * Much more reliable than BSE/NSE APIs which block server requests
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const BASE = 'https://www.screener.in';

const httpClient = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  }
});

/**
 * Parse a number string like "1,23,456.78" or "1234.5" → float
 */
function parseNumber(str) {
  if (!str || str === '' || str === '-') return null;
  const cleaned = str.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parse year from screener header like "Mar 2024" → 2024
 */
function parseYear(header) {
  const match = header?.match(/(\d{4})/);
  return match ? parseInt(match[1]) : null;
}

/**
 * Extract a financial table from screener page
 * Returns { years: [2024, 2023, ...], rows: { 'Revenue': [val1, val2, ...] } }
 */
function extractTable($, sectionId) {
  const section = $(`#${sectionId}`);
  if (!section.length) return null;

  const table = section.find('table').first();
  if (!table.length) return null;

  // Get years from header row
  const years = [];
  table.find('thead th').each((i, el) => {
    if (i === 0) return; // skip label column
    const year = parseYear($(el).text().trim());
    if (year) years.push(year);
  });

  if (years.length === 0) return null;

  // Get data rows
  const rows = {};
  table.find('tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (!cells.length) return;

    const label = $(cells[0]).text().trim().replace(/\s+/g, ' ');
    if (!label) return;

    const values = [];
    cells.each((i, cell) => {
      if (i === 0) return;
      values.push(parseNumber($(cell).text().trim()));
    });

    if (values.length > 0) rows[label] = values;
  });

  return { years, rows };
}

/**
 * Map screener row labels to our schema fields
 */
function mapPLData(rows, yearIndex) {
  const get = (keys) => {
    for (const key of keys) {
      const found = Object.keys(rows).find(k => k.toLowerCase().includes(key.toLowerCase()));
      if (found && rows[found][yearIndex] != null) return rows[found][yearIndex];
    }
    return null;
  };

  return {
    revenue: get(['Sales', 'Revenue from Operations', 'Revenue']),
    operatingProfit: get(['Operating Profit', 'EBITDA', 'PBDIT']),
    depreciation: get(['Depreciation']),
    ebit: get(['EBIT']),
    interestExpense: get(['Interest']),
    profitBeforeTax: get(['Profit before tax', 'PBT']),
    tax: get(['Tax']),
    netProfit: get(['Net Profit', 'PAT', 'Profit after tax']),
    eps: get(['EPS']),
    dividendPayout: get(['Dividend Payout']),
  };
}

function mapBalanceSheetData(rows, yearIndex) {
  const get = (keys) => {
    for (const key of keys) {
      const found = Object.keys(rows).find(k => k.toLowerCase().includes(key.toLowerCase()));
      if (found && rows[found][yearIndex] != null) return rows[found][yearIndex];
    }
    return null;
  };

  return {
    equity: get(['Equity Capital', 'Share Capital']),
    reserves: get(['Reserves']),
    borrowings: get(['Borrowings', 'Total Debt']),
    otherLiabilities: get(['Other Liabilities']),
    totalLiabilities: get(['Total Liabilities', 'Total Assets']),
    fixedAssets: get(['Fixed Assets', 'Net Block']),
    capitalWorkInProgress: get(['CWIP', 'Capital Work']),
    investments: get(['Investments']),
    otherAssets: get(['Other Assets']),
    totalAssets: get(['Total Assets']),
    tradeReceivables: get(['Debtors', 'Trade Receivables', 'Receivables']),
    inventory: get(['Inventory', 'Inventories']),
    cash: get(['Cash', 'Cash Equivalents']),
  };
}

function mapCashFlowData(rows, yearIndex) {
  const get = (keys) => {
    for (const key of keys) {
      const found = Object.keys(rows).find(k => k.toLowerCase().includes(key.toLowerCase()));
      if (found && rows[found][yearIndex] != null) return rows[found][yearIndex];
    }
    return null;
  };

  return {
    operatingCashFlow: get(['Cash from Operating', 'Operating Activities', 'CFO']),
    investingCashFlow: get(['Cash from Investing', 'Investing Activities', 'CFI']),
    financingCashFlow: get(['Cash from Financing', 'Financing Activities', 'CFF']),
    netCashFlow: get(['Net Cash Flow', 'Net Change']),
    capex: get(['Capital Expenditure', 'Capex', 'Purchase of Fixed']),
  };
}

/**
 * Main scraper — fetches consolidated financials from Screener.in
 * Returns array of { year, revenue, netProfit, ... } objects
 */
export async function scrapeScreener(symbol, consolidated = true) {
  const type = consolidated ? 'consolidated' : 'standalone';
  const url = `${BASE}/company/${symbol.toUpperCase()}/${type}/`;

  logger.info(`Scraping Screener.in for ${symbol} (${type})`, { url });

  let html;
  try {
    await sleep(DELAY);
    const res = await httpClient.get(url);
    html = res.data;
  } catch (err) {
    // Try standalone if consolidated fails
    if (consolidated) {
      logger.warn(`Consolidated not found for ${symbol}, trying standalone`);
      return scrapeScreener(symbol, false);
    }
    throw new Error(`Screener.in fetch failed for ${symbol}: ${err.message}`);
  }

  const $ = cheerio.load(html);

  // Check if company exists
  const title = $('h1').first().text().trim();
  if (!title || title.includes('Page not found')) {
    throw new Error(`Company "${symbol}" not found on Screener.in`);
  }

  logger.info(`Screener page loaded for: ${title}`);

  // Extract all financial tables
  const plTable = extractTable($, 'profit-loss');
  const bsTable = extractTable($, 'balance-sheet');
  const cfTable = extractTable($, 'cash-flow');

  if (!plTable) {
    throw new Error(`No P&L data found for ${symbol} on Screener.in`);
  }

  const years = plTable.years;
  logger.info(`Found ${years.length} years of data: ${years.join(', ')}`);

  // Build one record per year
  const results = [];
  for (let i = 0; i < years.length; i++) {
    const year = years[i];

    const pl = mapPLData(plTable.rows, i);
    const bs = bsTable ? mapBalanceSheetData(bsTable.rows, i) : {};
    const cf = cfTable ? mapCashFlowData(cfTable.rows, i) : {};

    // Compute derived ratios
    const totalDebt = bs.borrowings || 0;
    const totalEquity = (bs.equity || 0) + (bs.reserves || 0);
    const ebitda = pl.operatingProfit;
    const interestCoverage = (pl.interestExpense && ebitda)
      ? ebitda / pl.interestExpense : null;
    const debtToEquity = totalEquity > 0 ? totalDebt / totalEquity : null;
    const receivablesDays = (bs.tradeReceivables && pl.revenue)
      ? (bs.tradeReceivables / pl.revenue) * 365 : null;
    const operatingMargin = (ebitda && pl.revenue)
      ? (ebitda / pl.revenue) * 100 : null;
    const netMargin = (pl.netProfit && pl.revenue)
      ? (pl.netProfit / pl.revenue) * 100 : null;

    results.push({
      year,
      source: 'screener',
      extractionConfidence: 0.9,

      // P&L
      revenue: pl.revenue,
      operatingProfit: pl.operatingProfit,
      depreciation: pl.depreciation,
      ebit: pl.ebit,
      interestExpense: pl.interestExpense,
      profitBeforeTax: pl.profitBeforeTax,
      tax: pl.tax,
      netProfit: pl.netProfit,
      eps: pl.eps,

      // Balance Sheet
      equity: bs.equity,
      reserves: bs.reserves,
      totalDebt,
      totalEquity,
      fixedAssets: bs.fixedAssets,
      investments: bs.investments,
      tradeReceivables: bs.tradeReceivables,
      inventory: bs.inventory,
      cash: bs.cash,
      totalAssets: bs.totalAssets,

      // Cash Flow
      operatingCashFlow: cf.operatingCashFlow,
      investingCashFlow: cf.investingCashFlow,
      financingCashFlow: cf.financingCashFlow,
      capex: cf.capex,

      // Derived ratios
      operatingMargin,
      netMargin,
      interestCoverage,
      debtToEquity,
      receivablesDays,
    });
  }

  return results.sort((a, b) => a.year - b.year);
}

/**
 * Search for a company on Screener.in
 */
export async function searchScreener(query) {
  try {
    await sleep(500);
    const res = await httpClient.get(`${BASE}/api/company/search/?q=${encodeURIComponent(query)}&v=3`);
    if (!res.data?.results) return [];

    return res.data.results.slice(0, 5).map(r => ({
      name: r.name,
      url: r.url,
      symbol: r.url?.split('/').filter(Boolean).pop()?.toUpperCase()
    }));
  } catch (err) {
    logger.warn('Screener search failed', { error: err.message });
    return [];
  }
}