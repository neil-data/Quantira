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
 * Find a row value by exact or partial label match.
 * exactKeys are tried first (full string match), then partialKeys (includes match).
 * This prevents "Tax %" matching when you want "Tax" expense amount.
 */
function getRowValue(rows, exactKeys, partialKeys, yearIndex) {
  // 1. Try exact match first
  for (const key of exactKeys) {
    const found = Object.keys(rows).find(k => k.toLowerCase() === key.toLowerCase());
    if (found && rows[found][yearIndex] != null) return rows[found][yearIndex];
  }
  // 2. Fall back to partial match, but exclude percentage rows
  for (const key of partialKeys) {
    const found = Object.keys(rows).find(k =>
      k.toLowerCase().includes(key.toLowerCase()) &&
      !k.includes('%') &&
      !k.toLowerCase().includes('ratio')
    );
    if (found && rows[found][yearIndex] != null) return rows[found][yearIndex];
  }
  return null;
}

/**
 * Map screener row labels to our schema fields
 */
function mapPLData(rows, yearIndex) {
  const g = (exact, partial) => getRowValue(rows, exact, partial, yearIndex);

  return {
    revenue:          g(['Sales'], ['Revenue from Operations', 'Revenue', 'Sales']),
    operatingProfit:  g(['Operating Profit', 'PBDIT'], ['Operating Profit', 'EBITDA', 'PBDIT']),
    depreciation:     g(['Depreciation'], ['Depreciation']),
    ebit:             g(['EBIT'], ['EBIT']),
    interestExpense:  g(['Interest'], ['Interest']),
    // FIX: Use 'Profit before tax' exact match to avoid hitting 'Tax %'
    profitBeforeTax:  g(['Profit before tax', 'PBT'], ['Profit before tax']),
    // FIX: Use exact 'Tax' match — avoids 'Tax %' row
    tax:              g(['Tax'], ['Tax Expense', 'Income Tax']),
    netProfit:        g(['Net Profit', 'PAT'], ['Net Profit', 'Profit after tax']),
    eps:              g(['EPS in Rs', 'EPS'], ['EPS']),
    dividendPayout:   g(['Dividend Payout %'], ['Dividend Payout']),
  };
}

function mapBalanceSheetData(rows, yearIndex) {
  const g = (exact, partial) => getRowValue(rows, exact, partial, yearIndex);

  return {
    equity:              g(['Equity Capital', 'Share Capital'], ['Equity Capital', 'Share Capital']),
    reserves:            g(['Reserves'], ['Reserves']),
    borrowings:          g(['Borrowings'], ['Borrowings', 'Total Debt']),
    otherLiabilities:    g(['Other Liabilities'], ['Other Liabilities']),
    totalLiabilities:    g(['Total Liabilities'], ['Total Liabilities']),
    fixedAssets:         g(['Fixed Assets', 'Net Block'], ['Fixed Assets', 'Net Block']),
    capitalWorkInProgress: g(['CWIP'], ['Capital Work']),
    investments:         g(['Investments'], ['Investments']),
    otherAssets:         g(['Other Assets'], ['Other Assets']),
    totalAssets:         g(['Total Assets'], ['Total Assets']),
    // FIX: 'Debtor Days' is a ratio — look for the actual receivables balance
    tradeReceivables:    g(['Debtors', 'Trade Receivables'], ['Receivables', 'Debtors']),
    inventory:           g(['Inventory', 'Inventories'], ['Inventory']),
    // FIX: 'Cash Equivalents' is the correct Screener label
    cash:                g(['Cash Equivalents', 'Cash & Bank'], ['Cash Equivalent', 'Cash and Bank', 'Cash']),
  };
}

function mapCashFlowData(rows, yearIndex) {
  const g = (exact, partial) => getRowValue(rows, exact, partial, yearIndex);

  return {
    operatingCashFlow:  g(['Cash from Operating Activity'], ['Cash from Operating', 'Operating Activities', 'CFO']),
    investingCashFlow:  g(['Cash from Investing Activity'], ['Cash from Investing', 'Investing Activities', 'CFI']),
    financingCashFlow:  g(['Cash from Financing Activity'], ['Cash from Financing', 'Financing Activities', 'CFF']),
    netCashFlow:        g(['Net Cash Flow'], ['Net Cash Flow', 'Net Change']),
    capex:              g(['Capital Expenditure'], ['Capex', 'Purchase of Fixed']),
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

    // Compute derived fields
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

    // Compute actual tax amount if Screener gives tax as expense line
    // Guard: if tax value equals pbt, it's likely a parsing error — null it out
    const taxExpense = (pl.tax != null && pl.profitBeforeTax != null && pl.tax === pl.profitBeforeTax)
      ? null
      : pl.tax;

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
      tax: taxExpense,
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