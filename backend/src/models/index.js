import mongoose from 'mongoose';

// ─────────────────────────────────────────────
// Company model — master record for each entity
// ─────────────────────────────────────────────
const companySchema = new mongoose.Schema({
  cin: { type: String, unique: true, sparse: true },        // MCA CIN
  nseSymbol: { type: String, index: true },
  bseCode: { type: String, index: true },
  name: { type: String, required: true, index: true },
  nameNormalized: { type: String, index: true },             // lowercase stripped for fuzzy search
  industry: { type: String, index: true },                   // SEBI industry category
  sector: { type: String },                                  // broad sector (IT, BFSI, Pharma...)
  marketCap: { type: Number },                               // latest market cap in crore
  lastIngested: { type: Date },
  ingestStatus: {
    type: String,
    enum: ['pending', 'in_progress', 'complete', 'failed', 'partial'],
    default: 'pending'
  },
  yearsAvailable: [{ type: Number }],                        // [2015, 2016, ..., 2024]
  filingCount: { type: Number, default: 0 }
}, { timestamps: true });

companySchema.index({ nameNormalized: 'text', nseSymbol: 'text' });

// ──────────────────────────────────────────────────────────
// Filing model — one record per annual report PDF per year
// ──────────────────────────────────────────────────────────
const filingSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  cin: { type: String, index: true },
  year: { type: Number, required: true },                    // fiscal year end (e.g. 2023 = FY2022-23)
  filingType: {
    type: String,
    enum: ['annual_report', 'balance_sheet', 'pl_statement', 'cash_flow', 'auditor_report'],
    default: 'annual_report'
  },
  source: { type: String, enum: ['BSE', 'NSE', 'MCA', 'SEBI', 'manual'] },
  sourceUrl: { type: String },
  pdfPath: { type: String },                                 // local path or S3 key
  gridFsFileId: { type: mongoose.Schema.Types.ObjectId },
  pdfSize: { type: Number },
  parsedAt: { type: Date },
  parseStatus: {
    type: String,
    enum: ['pending', 'parsing', 'parsed', 'failed'],
    default: 'pending'
  },
  parseError: { type: String }
}, { timestamps: true });

filingSchema.index({ companyId: 1, year: 1, filingType: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────
// FinancialData model — structured numbers extracted from a filing
// One doc per company per year with all three statements consolidated
// ─────────────────────────────────────────────────────────────────────────
const financialDataSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  filingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Filing' },
  year: { type: Number, required: true },

  // ── Balance Sheet (all values in ₹ Crore) ──
  balanceSheet: {
    totalAssets: Number,
    totalLiabilities: Number,
    shareholdersEquity: Number,
    totalDebt: Number,
    longTermDebt: Number,
    shortTermDebt: Number,
    cashAndEquivalents: Number,
    accountsReceivable: Number,
    inventory: Number,
    fixedAssets: Number,
    goodwill: Number,
    intangibleAssets: Number,
    // Related party balances
    relatedPartyReceivables: Number,
    relatedPartyPayables: Number,
    relatedPartyLoansGiven: Number
  },

  // ── P&L Statement ──
  pnl: {
    revenue: Number,
    otherIncome: Number,
    totalIncome: Number,
    operatingExpenses: Number,
    ebitda: Number,
    depreciation: Number,
    ebit: Number,
    interestExpense: Number,
    pbt: Number,
    taxExpense: Number,
    pat: Number,                     // Profit after tax
    eps: Number,
    // Related party revenue
    relatedPartyRevenue: Number,
    relatedPartyExpenses: Number
  },

  // ── Cash Flow Statement ──
  cashFlow: {
    operatingCashFlow: Number,
    investingCashFlow: Number,
    financingCashFlow: Number,
    capex: Number,
    freeCashFlow: Number,
    dividendsPaid: Number
  },

  // ── Auditor information ──
  auditorInfo: {
    auditorName: String,
    auditorChanged: Boolean,         // changed from previous year
    qualifiedOpinion: Boolean,
    emphasisOfMatter: Boolean,
    keyAuditMatters: [String],
    rawText: String,                 // full auditor report text for NLP
    sentimentScore: Number,          // 1-10, filled by NLP service
    hedgingLanguage: [String]        // extracted phrases like "subject to", "we draw attention"
  },

  // ── Related party transactions (detailed) ──
  relatedPartyTransactions: [{
    party: String,
    relationship: String,
    transactionType: String,
    amount: Number,
    year: Number,
    lineRef: String                  // exact filing line reference
  }],

  // ── Management Discussion section ──
  managementDiscussion: {
    rawText: String,
    sentimentScore: Number
  },

  // ── Computed ratios (filled by anomaly engine on Day 2) ──
  ratios: {
    debtToEquity: Number,
    currentRatio: Number,
    interestCoverageRatio: Number,
    operatingCashFlowToRevenue: Number,
    revenueGrowthYoY: Number,
    patGrowthYoY: Number,
    cashFlowToRevenueGrowthGap: Number,  // KEY fraud signal
    receivablesDaysOutstanding: Number,
    relatedPartyTransactionRatio: Number,
    returnOnEquity: Number,
    returnOnAssets: Number,
    assetTurnover: Number
  },

  computedMetrics: {
    revenueVsCashFlowDivergence: Number,
    debtToEquityTrend: Number,
    receivablesGrowthVsRevenueGrowth: Number,
    relatedPartyTransactionPctRevenue: Number,
    interestCoverage: Number,
    operatingMarginVsProfitMarginGap: Number,
    operatingCashFlowToRevenue: Number,
    freeCashFlowToNetIncome: Number,
    receivablesDaysOutstanding: Number,
    inventoryDays: Number,
    debtToAssets: Number,
    assetTurnover: Number,
    returnOnAssets: Number,
    returnOnEquity: Number,
    taxRate: Number,
    cashToAssets: Number,
    netMargin: Number,
    operatingMargin: Number,
    yoyRevenueGrowth: Number,
    yoyPatGrowth: Number,
    yoyDebtGrowth: Number,
    yoyReceivablesGrowth: Number
  },

  anomalyProfile: {
    flaggedMetrics: [{
      metric: String,
      value: mongoose.Schema.Types.Mixed,
      zScore: Number,
      severity: { type: String, enum: ['low', 'medium', 'high', 'critical'] },
      reason: String
    }],
    anomalyScore: { type: Number, default: 0 },
    redFlags: { type: Number, default: 0 },
    zScores: mongoose.Schema.Types.Mixed,
    lastAnalyzedAt: Date
  },

  // ── Raw text sections for NLP ──
  rawSections: {
    fullText: String,
    auditorReport: String,
    relatedPartyDisclosures: String,
    managementDiscussion: String,
    notesToAccounts: String
  },

  extractionConfidence: { type: Number, min: 0, max: 1 },   // 0-1 confidence in extraction
  extractionWarnings: [String]
}, { timestamps: true });

financialDataSchema.index({ companyId: 1, year: 1 }, { unique: true });

export const Company = mongoose.model('Company', companySchema);
export const Filing = mongoose.model('Filing', filingSchema);
export const FinancialData = mongoose.model('FinancialData', financialDataSchema);