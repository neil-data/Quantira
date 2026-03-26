/**
 * PDF Parser — the most critical piece of Day 1
 * Extracts structured numbers from messy annual report PDFs
 *
 * Strategy:
 * 1. Extract full text with pdf-parse
 * 2. Find section boundaries (Balance Sheet, P&L, Cash Flow, Auditor Report)
 * 3. Use regex patterns + heuristics to pull numbers from tables
 * 4. Validate extracted data for basic consistency
 */

import pdfParse from 'pdf-parse';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

// ── Section detection patterns ──────────────────────────────────────────
const SECTION_PATTERNS = {
  balanceSheet: [
    /balance\s+sheet/i,
    /statement\s+of\s+(?:financial\s+)?(?:position|assets)/i,
    /ASSETS\s*(?:AND\s*LIABILITIES)?/
  ],
  pnl: [
    /(?:statement\s+of\s+)?(?:profit\s+(?:and|&)\s+loss)/i,
    /income\s+statement/i,
    /REVENUE\s+FROM\s+OPERATIONS/i
  ],
  cashFlow: [
    /cash\s+flow\s+statement/i,
    /statement\s+of\s+cash\s+flows?/i,
    /CASH\s+FLOWS?\s+FROM\s+OPERATING/i
  ],
  auditorReport: [
    /independent\s+auditor[''s]*\s+report/i,
    /auditor[''s]*\s+report\s+to\s+the\s+members/i,
    /report\s+on\s+the\s+(?:standalone|consolidated)\s+financial/i
  ],
  relatedParty: [
    /related\s+party\s+(?:transactions?|disclosures?)/i,
    /transactions\s+with\s+related\s+parties/i
  ],
  managementDiscussion: [
    /management[''s]*\s+discussion\s+(?:and\s+analysis)?/i,
    /MD\s*&\s*A/i
  ]
};

// ── Number extraction helpers ────────────────────────────────────────────

/**
 * Parse Indian number format: 1,23,456.78 or (1,23,456.78) for negatives
 */
function parseIndianNumber(str) {
  if (!str) return null;
  const cleaned = str.toString().trim();
  const isNegative = cleaned.startsWith('(') && cleaned.endsWith(')');
  const num = parseFloat(cleaned.replace(/[(),\s]/g, '').replace(/,/g, ''));
  if (isNaN(num)) return null;
  return isNegative ? -num : num;
}

/**
 * Try to find a labelled value in text
 * Handles: label followed by number on same or next line, Indian comma format
 */
function extractLabelledValue(text, patterns, multiplier = 1) {
  for (const pattern of patterns) {
    const match = text.match(new RegExp(
      pattern.source + '\\s*[:\\-]?\\s*(?:\\(\\s*)?([\\d,]+(?:\\.\\d+)?)(?:\\s*\\))?',
      'i'
    ));
    if (match) {
      const num = parseIndianNumber(match[1]);
      if (num !== null) return num * multiplier;
    }
  }
  return null;
}

/**
 * Detect if numbers are in crore/lakh/million and return normaliser
 * Most SEBI filings use ₹ Crore — we normalise everything to crore
 */
function detectUnitMultiplier(text) {
  const sample = text.slice(0, 3000);
  if (/\(₹\s*in\s*lakhs?\)/i.test(sample) || /\(in\s*(?:indian\s*)?rupees?\s*lakhs?\)/i.test(sample)) {
    return 0.01;  // lakh to crore
  }
  if (/\(₹\s*in\s*millions?\)/i.test(sample) || /\(in\s*(?:rs\.?\s*)?millions?\)/i.test(sample)) {
    return 0.1;   // million to crore
  }
  if (/\(₹\s*in\s*(?:thousands?|'000s?)\)/i.test(sample)) {
    return 0.0001; // thousands to crore
  }
  return 1; // already in crore
}

// ── Balance Sheet extractor ──────────────────────────────────────────────
function extractBalanceSheet(text, multiplier) {
  const m = multiplier;

  return {
    totalAssets: extractLabelledValue(text, [
      /total\s+assets/,
      /TOTAL\s+ASSETS/
    ], m),
    shareholdersEquity: extractLabelledValue(text, [
      /(?:total\s+)?(?:shareholders['']?\s+equity|equity\s+attributable|total\s+equity)/,
      /NET\s+WORTH/
    ], m),
    totalDebt: extractLabelledValue(text, [
      /total\s+(?:borrowings?|debt)/,
      /(?:long.term\s+borrowings?\s*\+\s*short.term)/
    ], m),
    longTermDebt: extractLabelledValue(text, [
      /long[\-\s]?term\s+borrowings?/,
      /non.current\s+borrowings?/
    ], m),
    shortTermDebt: extractLabelledValue(text, [
      /short[\-\s]?term\s+borrowings?/,
      /current\s+(?:maturities|portion).*borrowings?/
    ], m),
    cashAndEquivalents: extractLabelledValue(text, [
      /cash\s+and\s+(?:cash\s+)?equivalents?/,
      /cash\s+and\s+bank\s+balances?/
    ], m),
    accountsReceivable: extractLabelledValue(text, [
      /trade\s+receivables?/,
      /accounts?\s+receivables?/,
      /sundry\s+debtors?/
    ], m),
    inventory: extractLabelledValue(text, [
      /inventories/,
      /stocks?\s+in\s+trade/
    ], m),
    fixedAssets: extractLabelledValue(text, [
      /(?:net\s+)?(?:property|plant)\s*[,&]\s*(?:plant|equipment)/,
      /tangible\s+assets?/,
      /fixed\s+assets?/
    ], m),
    goodwill: extractLabelledValue(text, [/goodwill/], m),
    relatedPartyLoansGiven: extractLabelledValue(text, [
      /loans?\s+to\s+related\s+parties/,
      /inter.corporate\s+(?:deposits?|loans?)/
    ], m)
  };
}

// ── P&L extractor ────────────────────────────────────────────────────────
function extractPnL(text, multiplier) {
  const m = multiplier;

  const revenue = extractLabelledValue(text, [
    /revenue\s+from\s+operations?/,
    /net\s+(?:revenue|sales)/,
    /total\s+revenue\s+from\s+operations?/
  ], m);

  const otherIncome = extractLabelledValue(text, [
    /other\s+income/,
    /non.operating\s+income/
  ], m);

  const totalIncome = extractLabelledValue(text, [
    /total\s+income/,
    /gross\s+income/
  ], m) || ((revenue || 0) + (otherIncome || 0)) || null;

  const operatingExpenses = extractLabelledValue(text, [
    /total\s+(?:operating\s+)?expenses?/,
    /total\s+expenditure/
  ], m);

  const depreciation = extractLabelledValue(text, [
    /depreciation(?:\s+and\s+(?:amortization|amortisation))?/,
    /D(?:epreciation)?&A/
  ], m);

  const interestExpense = extractLabelledValue(text, [
    /finance\s+(?:costs?|charges?)/,
    /interest\s+expense/,
    /interest\s+(?:paid|cost)/
  ], m);

  const pbt = extractLabelledValue(text, [
    /profit\s+before\s+(?:tax|taxation)/,
    /PBT/
  ], m);

  const taxExpense = extractLabelledValue(text, [
    /tax\s+expense/,
    /income\s+tax\s+expense/,
    /(?:current|deferred)\s+tax/
  ], m);

  const pat = extractLabelledValue(text, [
    /profit\s+(?:for\s+the\s+(?:year|period)|after\s+tax)/,
    /net\s+profit/,
    /PAT/
  ], m);

  return {
    revenue,
    otherIncome,
    totalIncome,
    operatingExpenses,
    depreciation,
    interestExpense,
    pbt,
    taxExpense,
    pat,
    eps: extractLabelledValue(text, [/(?:basic\s+)?(?:earnings|EPS)\s+per\s+share/], 1)
  };
}

// ── Cash Flow extractor ──────────────────────────────────────────────────
function extractCashFlow(text, multiplier) {
  const m = multiplier;

  const operatingCashFlow = extractLabelledValue(text, [
    /net\s+cash\s+(?:from|generated\s+(?:from|by))\s+operating/,
    /cash\s+flows?\s+from\s+operating\s+activities?/
  ], m);

  const investingCashFlow = extractLabelledValue(text, [
    /net\s+cash\s+(?:used\s+in|from)\s+investing/,
    /cash\s+flows?\s+from\s+investing\s+activities?/
  ], m);

  const financingCashFlow = extractLabelledValue(text, [
    /net\s+cash\s+(?:from|used\s+in)\s+financing/,
    /cash\s+flows?\s+from\s+financing\s+activities?/
  ], m);

  const capex = extractLabelledValue(text, [
    /(?:purchase|acquisition)\s+of\s+(?:property|fixed\s+assets?|PPE)/,
    /capital\s+expenditure/
  ], m);

  return {
    operatingCashFlow,
    investingCashFlow,
    financingCashFlow,
    capex: capex ? Math.abs(capex) : null,
    freeCashFlow: (operatingCashFlow !== null && capex !== null)
      ? operatingCashFlow - Math.abs(capex)
      : null,
    dividendsPaid: extractLabelledValue(text, [
      /dividend(?:s)?\s+paid/,
      /payment\s+of\s+dividend/
    ], m)
  };
}

// ── Auditor report extractor ─────────────────────────────────────────────
function extractAuditorInfo(text) {
  const lowerText = text.toLowerCase();

  const qualifiedOpinion = /qualified\s+opinion|adverse\s+opinion/i.test(text) &&
                           !/unqualified\s+opinion/i.test(text);

  const emphasisOfMatter = /emphasis\s+of\s+matter/i.test(text);

  // Extract key audit matters
  const kamMatches = text.match(/key\s+audit\s+matter[s\s:]+(.*?)(?=\n\n|\n[A-Z])/is);
  const keyAuditMatters = [];
  if (kamMatches) {
    const kamText = kamMatches[1];
    const items = kamText.split(/\n+/).filter(l => l.trim().length > 20);
    keyAuditMatters.push(...items.slice(0, 5).map(i => i.trim().slice(0, 200)));
  }

  // Hedging language patterns — a key fraud signal
  const HEDGING_PATTERNS = [
    /we\s+draw\s+attention/gi,
    /subject\s+to\s+(?:the\s+)?(?:above|following|our)/gi,
    /material\s+uncertainty/gi,
    /going\s+concern/gi,
    /unable\s+to\s+(?:verify|obtain|confirm)/gi,
    /except\s+for\s+the\s+(?:possible|potential)/gi,
    /significant\s+doubt/gi,
    /we\s+were\s+unable/gi,
    /limitations?\s+on\s+(?:our\s+)?(?:scope|audit)/gi,
    /management\s+(?:has|have)\s+(?:not\s+)?provided/gi
  ];

  const hedgingLanguage = [];
  for (const pattern of HEDGING_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) hedgingLanguage.push(...matches.slice(0, 2));
  }

  return {
    qualifiedOpinion,
    emphasisOfMatter,
    keyAuditMatters,
    hedgingLanguage: [...new Set(hedgingLanguage)],
    rawText: text.slice(0, 5000)  // first 5000 chars for NLP service
  };
}

// ── Related party extractor ──────────────────────────────────────────────
function extractRelatedParties(text) {
  const transactions = [];

  // Find related party section
  const rpStart = text.search(/related\s+party\s+(?:transactions?|disclosures?)/i);
  if (rpStart === -1) return transactions;

  const rpSection = text.slice(rpStart, rpStart + 8000);

  // Common related party transaction keywords
  const txnPatterns = [
    { type: 'sale', pattern: /(?:sales?|revenue)\s+to\s+([A-Z][^,\n]+?)\s+([\d,]+(?:\.\d+)?)/gm },
    { type: 'purchase', pattern: /(?:purchase|procurement)\s+from\s+([A-Z][^,\n]+?)\s+([\d,]+(?:\.\d+)?)/gm },
    { type: 'loan', pattern: /(?:loan|advances?)\s+(?:given\s+to|received\s+from)\s+([A-Z][^,\n]+?)\s+([\d,]+(?:\.\d+)?)/gm },
    { type: 'rent', pattern: /(?:rent|lease)\s+(?:paid|received)\s+(?:to|from)\s+([A-Z][^,\n]+?)\s+([\d,]+(?:\.\d+)?)/gm }
  ];

  for (const { type, pattern } of txnPatterns) {
    let match;
    while ((match = pattern.exec(rpSection)) !== null) {
      const amount = parseIndianNumber(match[2]);
      if (amount && amount > 0) {
        transactions.push({
          transactionType: type,
          party: match[1].trim().slice(0, 100),
          amount,
          lineRef: `Related Party Disclosures - ${type}`
        });
      }
    }
  }

  return transactions.slice(0, 20);  // cap at 20 transactions
}

// ── Section splitter ─────────────────────────────────────────────────────
function splitIntoSections(fullText) {
  const sections = {
    fullText,
    balanceSheet: '',
    pnl: '',
    cashFlow: '',
    auditorReport: '',
    relatedPartyDisclosures: '',
    managementDiscussion: ''
  };

  const sectionOrder = ['auditorReport', 'managementDiscussion', 'relatedParty', 'balanceSheet', 'pnl', 'cashFlow'];
  const positions = [];

  for (const [sectionName, patterns] of Object.entries(SECTION_PATTERNS)) {
    for (const pattern of patterns) {
      const idx = fullText.search(pattern);
      if (idx !== -1) {
        positions.push({ name: sectionName, start: idx });
        break;
      }
    }
  }

  positions.sort((a, b) => a.start - b.start);

  for (let i = 0; i < positions.length; i++) {
    const { name, start } = positions[i];
    const end = positions[i + 1]?.start || fullText.length;
    const sectionText = fullText.slice(start, end);
    const key = name === 'relatedParty' ? 'relatedPartyDisclosures' : name;
    sections[key] = sectionText;
  }

  return sections;
}

// ── Main parse function ───────────────────────────────────────────────────
export async function parsePDF(pdfPath) {
  logger.info('Parsing PDF', { pdfPath });

  const dataBuffer = await fs.readFile(pdfPath);
  const parsed = await pdfParse(dataBuffer, {
    pagerender: null,   // skip canvas rendering
    max: 0              // parse all pages
  });

  const fullText = parsed.text;
  const pageCount = parsed.numpages;

  if (!fullText || fullText.length < 500) {
    throw new Error('PDF text extraction returned insufficient content — may be image-only PDF');
  }

  const multiplier = detectUnitMultiplier(fullText);
  const sections = splitIntoSections(fullText);

  const warnings = [];

  // Extract each section
  const balanceSheet = extractBalanceSheet(sections.balanceSheet || fullText, multiplier);
  const pnl = extractPnL(sections.pnl || fullText, multiplier);
  const cashFlow = extractCashFlow(sections.cashFlow || fullText, multiplier);
  const auditorInfo = extractAuditorInfo(sections.auditorReport || fullText.slice(0, 10000));
  const relatedPartyTransactions = extractRelatedParties(sections.relatedPartyDisclosures || fullText);

  // Validate key numbers
  if (!pnl.revenue) warnings.push('Revenue not found — may need manual review');
  if (!balanceSheet.totalAssets) warnings.push('Total assets not found');
  if (!cashFlow.operatingCashFlow) warnings.push('Operating cash flow not found');

  // Confidence score based on how many fields we got
  const fields = [
    balanceSheet.totalAssets, balanceSheet.shareholdersEquity, balanceSheet.totalDebt,
    pnl.revenue, pnl.pat, pnl.ebit,
    cashFlow.operatingCashFlow
  ];
  const filled = fields.filter(f => f !== null && f !== undefined).length;
  const confidence = filled / fields.length;

  logger.info('PDF parsed', {
    pdfPath,
    pageCount,
    multiplier,
    confidence,
    warnings: warnings.length
  });

  return {
    balanceSheet,
    pnl,
    cashFlow,
    auditorInfo,
    relatedPartyTransactions,
    rawSections: {
      fullText: fullText.slice(0, 50000),  // truncate to 50k chars for storage
      auditorReport: sections.auditorReport?.slice(0, 10000),
      relatedPartyDisclosures: sections.relatedPartyDisclosures?.slice(0, 10000),
      managementDiscussion: sections.managementDiscussion?.slice(0, 10000)
    },
    extractionConfidence: confidence,
    extractionWarnings: warnings,
    pageCount
  };
}