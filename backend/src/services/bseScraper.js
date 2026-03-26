/**
 * BSE (Bombay Stock Exchange) scraper
 * Uses BSE's public API with proper headers and fallback strategies
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

// BSE requires these exact headers to avoid 403s
const httpClient = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://www.bseindia.com',
    'Referer': 'https://www.bseindia.com/',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Connection': 'keep-alive'
  }
});

/**
 * Search for a company on BSE by name or symbol
 */
export async function searchCompanyBSE(query) {
  try {
    await sleep(DELAY);
    const url = `https://api.bseindia.com/BseIndiaAPI/api/fetchCompanyData/w?Type=Q&text=${encodeURIComponent(query)}`;
    const res = await httpClient.get(url);

    if (!res.data || !Array.isArray(res.data)) return [];

    return res.data.slice(0, 5).map(c => ({
      bseCode: c.SECURITY_CODE,
      name: c.COMPANY_NAME,
      industry: c.INDUSTRY,
      sector: c.SECTOR,
      isinCode: c.ISIN_CODE,
      nseSymbol: c.NSE_SYMBOL || null
    }));
  } catch (err) {
    logger.warn('BSE company search failed', { query, error: err.message });
    return [];
  }
}

/**
 * Get annual report filings for a BSE code
 * Tries multiple BSE endpoints
 */
export async function getAnnualReportsBSE(bseCode, fromYear = 2014) {
  const filings = [];

  // Strategy 1: BSE annual reports API
  try {
    await sleep(DELAY);
    const url = `https://api.bseindia.com/BseIndiaAPI/api/AnnualReports/w?scripcode=${bseCode}&Filetype=C`;
    const res = await httpClient.get(url);

    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      for (const item of res.data) {
        const yearMatch = item.SUBMISSION_DATE?.match(/(\d{4})$/);
        const year = yearMatch ? parseInt(yearMatch[1]) : null;
        if (!year || year < fromYear) continue;

        const month = item.SUBMISSION_DATE?.split('/')[1];
        const fiscalYear = ['07','08','09','10','11','12'].includes(month) ? year : year - 1;

        if (item.ATTACHMENTNAME) {
          filings.push({
            year: fiscalYear,
            pdfUrl: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${item.ATTACHMENTNAME}`,
            fileName: item.ATTACHMENTNAME,
            filingDate: item.SUBMISSION_DATE,
            source: 'BSE',
            bseCode
          });
        }
      }

      if (filings.length > 0) {
        logger.info(`Found ${filings.length} BSE annual reports for ${bseCode}`);
        return filings;
      }
    }
  } catch (err) {
    logger.warn('BSE annual reports API failed, trying fallback', { bseCode, error: err.message });
  }

  // Strategy 2: BSE corp filing search
  try {
    await sleep(DELAY);
    const url = `https://api.bseindia.com/BseIndiaAPI/api/AnnualReportNewFiles/w?scripcode=${bseCode}`;
    const res = await httpClient.get(url);

    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      for (const item of res.data) {
        const year = parseInt(item.YEAR || item.year);
        if (!year || year < fromYear) continue;

        const pdfUrl = item.PDFURL || item.pdfUrl || item.FILENAME;
        if (!pdfUrl) continue;

        filings.push({
          year,
          pdfUrl: pdfUrl.startsWith('http') ? pdfUrl : `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${pdfUrl}`,
          filingDate: item.DATE || item.date,
          source: 'BSE',
          bseCode
        });
      }

      if (filings.length > 0) {
        logger.info(`Found ${filings.length} BSE annual reports (fallback) for ${bseCode}`);
        return filings;
      }
    }
  } catch (err) {
    logger.warn('BSE fallback also failed', { bseCode, error: err.message });
  }

  logger.warn(`No BSE annual reports found for ${bseCode}`);
  return filings;
}

/**
 * Get quarterly filings from BSE
 */
export async function getQuarterlyFilingsBSE(bseCode) {
  try {
    await sleep(DELAY);
    const url = `https://api.bseindia.com/BseIndiaAPI/api/FinancialResults/w?Scode=${bseCode}&Stocktype=C&Period=F`;
    const res = await httpClient.get(url);
    if (!res.data?.Table) return [];

    return res.data.Table.map(item => ({
      period: item.QUARTERENDDATE,
      pdfUrl: item.FILENAME ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${item.FILENAME}` : null,
      type: item.TYPENAME,
      source: 'BSE'
    })).filter(f => f.pdfUrl);
  } catch (err) {
    logger.warn('BSE quarterly filings fetch failed', { bseCode, error: err.message });
    return [];
  }
}