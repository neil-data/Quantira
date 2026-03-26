/**
 * NSE (National Stock Exchange) scraper
 * NSE requires cookie-based session — fetches homepage first then uses cookies
 * Has aggressive anti-bot measures so we implement proper session management
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

const NSE_BASE = 'https://www.nseindia.com';
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

// NSE session state
let nseSession = {
  cookies: '',
  fetchedAt: 0,
  valid: false
};

/**
 * Initialize NSE session by hitting homepage to get cookies
 */
async function getNSESession() {
  const SESSION_TTL = 4 * 60 * 1000; // 4 minutes
  if (nseSession.valid && Date.now() - nseSession.fetchedAt < SESSION_TTL) {
    return nseSession.cookies;
  }

  try {
    // Step 1: hit homepage
    const homeRes = await axios.get(`${NSE_BASE}/`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    const cookies1 = homeRes.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';

    await sleep(1000);

    // Step 2: hit market data page to get additional cookies
    const marketRes = await axios.get(`${NSE_BASE}/market-data/live-equity-market`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `${NSE_BASE}/`,
        'Cookie': cookies1
      }
    });

    const cookies2 = marketRes.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';
    const allCookies = [cookies1, cookies2].filter(Boolean).join('; ');

    nseSession = { cookies: allCookies, fetchedAt: Date.now(), valid: true };
    logger.info('NSE session initialized');
    return allCookies;
  } catch (err) {
    logger.warn('NSE session init failed', { error: err.message });
    nseSession.valid = false;
    return '';
  }
}

function makeNSEClient(cookies) {
  return axios.create({
    baseURL: NSE_BASE,
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${NSE_BASE}/`,
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Cookie': cookies
    }
  });
}

/**
 * Search company by name or symbol on NSE
 */
export async function searchCompanyNSE(query) {
  try {
    const cookies = await getNSESession();
    const client = makeNSEClient(cookies);
    await sleep(DELAY);

    const res = await client.get(`/api/search/autocomplete?q=${encodeURIComponent(query)}&type=equity`);
    if (!res.data?.symbols) return [];

    return res.data.symbols.slice(0, 5).map(s => ({
      nseSymbol: s.symbol,
      name: s.symbol_info || s.name,
      isin: s.isin,
      source: 'NSE'
    }));
  } catch (err) {
    logger.warn('NSE company search failed', { query, error: err.message });
    return [];
  }
}

/**
 * Get detailed company info from NSE
 */
export async function getCompanyInfoNSE(symbol) {
  try {
    const cookies = await getNSESession();
    const client = makeNSEClient(cookies);
    await sleep(DELAY);

    const res = await client.get(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
    const info = res.data?.info;
    if (!info) return null;

    return {
      nseSymbol: symbol,
      name: info.companyName,
      industry: info.industry,
      isin: info.isin,
      sector: info.sector
    };
  } catch (err) {
    logger.warn('NSE company info failed', { symbol, error: err.message });
    return null;
  }
}

/**
 * Get annual report URLs from NSE
 */
export async function getAnnualReportsNSE(symbol, fromYear = 2014) {
  const filings = [];

  try {
    const cookies = await getNSESession();
    const client = makeNSEClient(cookies);
    await sleep(DELAY);

    const res = await client.get(
      `/api/annual-reports?index=equities&symbol=${encodeURIComponent(symbol)}`
    );

    if (!res.data || !Array.isArray(res.data)) return filings;

    for (const item of res.data) {
      const year = parseInt(item.toYear || item.year);
      if (!year || year < fromYear) continue;

      if (!item.fileName) continue;

      filings.push({
        year,
        pdfUrl: item.fileName.startsWith('http') ? item.fileName : `${NSE_BASE}${item.fileName}`,
        filingDate: item.date,
        source: 'NSE',
        nseSymbol: symbol
      });
    }

    logger.info(`Found ${filings.length} NSE annual reports for ${symbol}`);
    return filings;
  } catch (err) {
    logger.warn('NSE annual reports fetch failed', { symbol, error: err.message });
    return filings;
  }
}

/**
 * Get financial data from NSE structured API
 */
export async function getFinancialDataNSE(symbol) {
  try {
    const cookies = await getNSESession();
    const client = makeNSEClient(cookies);
    await sleep(DELAY);

    const [balSheet, pnl] = await Promise.allSettled([
      client.get(`/api/financial-results?index=equities&symbol=${symbol}&type=Consolidated&period=Annual`),
      client.get(`/api/annual-financial-data?symbol=${symbol}`)
    ]);

    return {
      balanceSheet: balSheet.status === 'fulfilled' ? balSheet.value.data : null,
      pnl: pnl.status === 'fulfilled' ? pnl.value.data : null
    };
  } catch (err) {
    logger.warn('NSE financial data fetch failed', { symbol, error: err.message });
    return {};
  }
}