/**
 * Anomaly Detection Engine
 * Reads nested financial data (pnl, balanceSheet, cashFlow) stored by ingestionOrchestrator
 * Computes key Day 2 ratios with Z-score analysis and per-year persistence
 */

import { FinancialData, Company } from '../models/index.js';
import { logger } from '../utils/logger.js';

function safeDivide(a, b) {
  if (a == null || b == null || b === 0) return null;
  const r = a / b;
  return isFinite(r) ? r : null;
}

export const runAnomalyEngine = async (companyId, onProgress = () => {}) => {
  try {
    logger.info(`Running anomaly detection for company: ${companyId}`);
    onProgress('analyzing', 85, 'Analyzing financial patterns...');

    const records = await FinancialData.find({ companyId }).sort({ year: 1 }).lean();

    if (records.length === 0) {
      logger.warn(`No financial data for anomaly analysis: ${companyId}`);
      return { companyId, anomaliesDetected: 0, anomalies: [] };
    }

    const metricsPerYear = records.map((record, idx) => {
      const previous = idx > 0 ? records[idx - 1] : null;
      return computeMetrics(record, previous);
    });
    const metricsWithZScores = computeZScores(metricsPerYear);

    // --- Day 3: Industry Peer Benchmarking ---
    const { benchmarkAnomalies } = require('./benchmarkingService');
    // Assume sector is available on company or record (customize as needed)
    const company = await Company.findById(companyId).lean();
    const sector = company?.sector || 'IT'; // fallback sector
    const allAnomalies = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const metricsData = metricsWithZScores[i];
      let yearAnomalies = detectAnomalies(metricsData, record.year);
      // Benchmark flagged metrics against sector medians
      yearAnomalies = await benchmarkAnomalies(sector, yearAnomalies);
      allAnomalies.push(...yearAnomalies);

      const anomalyScore = calculateAnomalyScore(yearAnomalies);

      await FinancialData.updateOne(
        { _id: record._id },
        {
          $set: {
            ratios: {
              debtToEquity: metricsData.metrics.debtToEquity,
              interestCoverageRatio: metricsData.metrics.interestCoverage,
              operatingCashFlowToRevenue: metricsData.metrics.cashFlowToRevenue,
              revenueGrowthYoY: metricsData.metrics.yoyRevenueGrowth,
              patGrowthYoY: metricsData.metrics.yoyPatGrowth,
              cashFlowToRevenueGrowthGap: metricsData.metrics.receivablesGrowthVsRevenueGrowth,
              receivablesDaysOutstanding: metricsData.metrics.receivablesDays,
              relatedPartyTransactionRatio: metricsData.metrics.relatedPartyTransactionPctRevenue,
              returnOnEquity: metricsData.metrics.roe,
              returnOnAssets: metricsData.metrics.roa,
              assetTurnover: metricsData.metrics.assetTurnover
            },
            computedMetrics: {
              revenueVsCashFlowDivergence: metricsData.metrics.revenueVsCashFlowDivergence,
              debtToEquityTrend: metricsData.metrics.debtToEquityTrend,
              receivablesGrowthVsRevenueGrowth: metricsData.metrics.receivablesGrowthVsRevenueGrowth,
              relatedPartyTransactionPctRevenue: metricsData.metrics.relatedPartyTransactionPctRevenue,
              interestCoverage: metricsData.metrics.interestCoverage,
              operatingMarginVsProfitMarginGap: metricsData.metrics.operatingMarginVsProfitMarginGap,
              operatingCashFlowToRevenue: metricsData.metrics.cashFlowToRevenue,
              freeCashFlowToNetIncome: metricsData.metrics.fcfToNI,
              receivablesDaysOutstanding: metricsData.metrics.receivablesDays,
              inventoryDays: metricsData.metrics.inventoryDays,
              debtToAssets: metricsData.metrics.debtToAssets,
              assetTurnover: metricsData.metrics.assetTurnover,
              returnOnAssets: metricsData.metrics.roa,
              returnOnEquity: metricsData.metrics.roe,
              taxRate: metricsData.metrics.effectiveTaxRate,
              cashToAssets: metricsData.metrics.cashToAssets,
              netMargin: metricsData.metrics.netMargin,
              operatingMargin: metricsData.metrics.operatingMargin,
              yoyRevenueGrowth: metricsData.metrics.yoyRevenueGrowth,
              yoyPatGrowth: metricsData.metrics.yoyPatGrowth,
              yoyDebtGrowth: metricsData.metrics.yoyDebtGrowth,
              yoyReceivablesGrowth: metricsData.metrics.yoyReceivablesGrowth
            },
            anomalyProfile: {
              flaggedMetrics: yearAnomalies.map(a => ({
                metric: a.metric,
                value: a.value,
                zScore: a.zScore,
                severity: a.severity,
                reason: a.reason
              })),
              anomalyScore,
              redFlags: yearAnomalies.length,
              zScores: metricsData.zScores,
              lastAnalyzedAt: new Date()
            }
          }
        }
      );
    }

    onProgress('analyzing', 95, `Found ${allAnomalies.length} potential anomalies`);

    const summary = {
      totalYearsAnalyzed: records.length,
      yearsWithAnomalies: new Set(allAnomalies.map(a => a.year)).size,
      totalAnomalies: allAnomalies.length,
      criticalAnomalies: allAnomalies.filter(a => a.severity === 'critical').length,
      highAnomalies: allAnomalies.filter(a => a.severity === 'high').length,
      lastAnalyzedAt: new Date()
    };

    await Company.findByIdAndUpdate(companyId, { anomalySummary: summary });
    logger.info(`Anomaly detection complete: ${allAnomalies.length} anomalies found`, { companyId });

    return { companyId, anomaliesDetected: allAnomalies.length, anomalies: allAnomalies, summary };

  } catch (error) {
    logger.error(`Anomaly engine error: ${error.message}`);
    throw error;
  }
};

/**
 * Compute Day 2 metrics from nested MongoDB schema
 */
function computeMetrics(r, prev) {
  // Read from nested schema
  const pnl = r.pnl || {};
  const bs  = r.balanceSheet || {};
  const cf  = r.cashFlow || {};

  const revenue          = pnl.revenue;
  const netProfit        = pnl.pat;
  const operatingProfit  = pnl.ebitda;
  const ebit             = pnl.ebit;
  const interestExpense  = pnl.interestExpense;
  const profitBeforeTax  = pnl.pbt;
  const tax              = pnl.taxExpense;
  const ocf              = cf.operatingCashFlow;
  const capex            = cf.capex;
  const fcf              = cf.freeCashFlow ?? (ocf != null && capex != null ? ocf - capex : null);
  const totalAssets      = bs.totalAssets;
  const totalDebt        = bs.totalDebt;
  const totalEquity      = bs.shareholdersEquity;
  const tradeReceivables = bs.accountsReceivable;
  const inventory        = bs.inventory;
  const cash             = bs.cashAndEquivalents;

  const relatedPartyTotal = (r.relatedPartyTransactions || [])
    .reduce((sum, tx) => sum + (tx.amount || 0), 0);

  const prevPnl = prev?.pnl || {};
  const prevBs = prev?.balanceSheet || {};
  const prevRevenue = prevPnl.revenue;
  const prevPat = prevPnl.pat;
  const prevDebt = prevBs.totalDebt;
  const prevReceivables = prevBs.accountsReceivable;

  // Compute metrics
  const netMargin              = safeDivide(netProfit, revenue) != null ? safeDivide(netProfit, revenue) * 100 : null;
  const operatingMargin        = safeDivide(operatingProfit, revenue) != null ? safeDivide(operatingProfit, revenue) * 100 : null;
  const marginDivergence       = (netMargin != null && operatingMargin != null) ? Math.abs(netMargin - operatingMargin) : null;
  const operatingMarginVsProfitMarginGap = marginDivergence;
  const cashFlowToRevenue      = safeDivide(ocf, revenue);
  const revenueVsCashFlowDivergence = cashFlowToRevenue != null ? Math.abs(1 - cashFlowToRevenue) : null;
  const fcfToNI                = safeDivide(fcf, netProfit);
  const cashConversionEff      = safeDivide(ocf, netProfit);
  const debtToEquity           = safeDivide(totalDebt, totalEquity);
  const debtToAssets           = safeDivide(totalDebt, totalAssets);
  const interestCoverage       = safeDivide(ebit, interestExpense);
  const receivablesDays        = (tradeReceivables != null && revenue != null && revenue > 0) ? (tradeReceivables / revenue) * 365 : null;
  const inventoryDays          = (inventory != null && revenue != null && revenue > 0) ? (inventory / revenue) * 365 : null;
  const assetTurnover          = safeDivide(revenue, totalAssets);
  const roa                    = (netProfit != null && totalAssets != null && totalAssets > 0) ? (netProfit / totalAssets) * 100 : null;
  const roe                    = (netProfit != null && totalEquity != null && totalEquity > 0) ? (netProfit / totalEquity) * 100 : null;
  const effectiveTaxRate       = safeDivide(tax, profitBeforeTax);
  const cashToAssets           = safeDivide(cash, totalAssets);

  const yoyRevenueGrowth       = (prevRevenue != null && prevRevenue !== 0 && revenue != null)
    ? ((revenue - prevRevenue) / Math.abs(prevRevenue)) * 100
    : null;
  const yoyPatGrowth           = (prevPat != null && prevPat !== 0 && netProfit != null)
    ? ((netProfit - prevPat) / Math.abs(prevPat)) * 100
    : null;
  const yoyDebtGrowth          = (prevDebt != null && prevDebt !== 0 && totalDebt != null)
    ? ((totalDebt - prevDebt) / Math.abs(prevDebt)) * 100
    : null;
  const yoyReceivablesGrowth   = (prevReceivables != null && prevReceivables !== 0 && tradeReceivables != null)
    ? ((tradeReceivables - prevReceivables) / Math.abs(prevReceivables)) * 100
    : null;

  const receivablesGrowthVsRevenueGrowth =
    (yoyReceivablesGrowth != null && yoyRevenueGrowth != null)
      ? yoyReceivablesGrowth - yoyRevenueGrowth
      : null;

  const debtToEquityTrend =
    (prevDebt != null && prevBs?.shareholdersEquity != null)
      ? debtToEquity - safeDivide(prevDebt, prevBs.shareholdersEquity)
      : null;

  const relatedPartyTransactionPctRevenue =
    safeDivide(relatedPartyTotal, revenue) != null ? safeDivide(relatedPartyTotal, revenue) * 100 : null;

  return {
    year: r.year,
    metrics: {
      netMargin, operatingMargin, marginDivergence,
      revenueVsCashFlowDivergence,
      debtToEquityTrend,
      receivablesGrowthVsRevenueGrowth,
      relatedPartyTransactionPctRevenue,
      operatingMarginVsProfitMarginGap,
      cashFlowToRevenue, fcfToNI, cashConversionEff,
      debtToEquity, debtToAssets, interestCoverage,
      receivablesDays, inventoryDays, assetTurnover,
      roa, roe, effectiveTaxRate, cashToAssets,
      yoyRevenueGrowth, yoyPatGrowth, yoyDebtGrowth, yoyReceivablesGrowth,
      // Raw values for context
      revenue, netProfit, ocf, totalDebt, totalEquity, totalAssets
    }
  };
}

function computeZScores(metricsPerYear) {
  if (metricsPerYear.length === 0) return [];
  const metricNames = Object.keys(metricsPerYear[0].metrics);

  const stats = {};
  for (const key of metricNames) {
    const values = metricsPerYear.map(m => m.metrics[key]).filter(v => v != null && isFinite(v));
    if (values.length < 2) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
    stats[key] = { mean, stdDev: Math.sqrt(variance) };
  }

  return metricsPerYear.map(({ year, metrics }) => {
    const zScores = {};
    for (const key in metrics) {
      const v = metrics[key];
      const s = stats[key];
      if (!s || v == null || !isFinite(v)) { zScores[key] = null; continue; }
      zScores[key] = s.stdDev === 0 ? 0 : parseFloat(((v - s.mean) / s.stdDev).toFixed(2));
    }
    return { year, metrics, zScores };
  });
}

function detectAnomalies({ metrics, zScores }, year) {
  const anomalies = [];
  const flag = (metric, value, zScore, severity, reason) =>
    anomalies.push({ year, metric, value, zScore, severity, reason });

  // 1. Revenue vs Cash Flow divergence
  if (metrics.cashFlowToRevenue != null && metrics.cashFlowToRevenue < 0.5) {
    flag('CASH_FLOW_QUALITY', metrics.cashFlowToRevenue.toFixed(2), zScores.cashFlowToRevenue,
      Math.abs(zScores.cashFlowToRevenue ?? 0) > 3 ? 'critical' : 'high',
      `OCF is only ${(metrics.cashFlowToRevenue * 100).toFixed(0)}% of revenue (healthy: >80%)`);
  }

  // 2. Accrual anomaly
  if (metrics.fcfToNI != null && metrics.fcfToNI < 0.7) {
    flag('ACCRUAL_ANOMALY', metrics.fcfToNI.toFixed(2), zScores.fcfToNI,
      Math.abs(zScores.fcfToNI ?? 0) > 2.5 ? 'critical' : 'high',
      `FCF is only ${(metrics.fcfToNI * 100).toFixed(0)}% of net income — possible earnings inflation`);
  }

  // 3. Margin divergence
  if (metrics.marginDivergence != null && metrics.marginDivergence > 10) {
    flag('MARGIN_DIVERGENCE', metrics.marginDivergence.toFixed(2), zScores.marginDivergence,
      metrics.marginDivergence > 20 ? 'critical' : 'high',
      `Operating margin (${metrics.operatingMargin?.toFixed(1)}%) vs net margin (${metrics.netMargin?.toFixed(1)}%) — unusual below-EBIT items`);
  }

  // 4. Receivables spike
  if (zScores.receivablesDays != null && Math.abs(zScores.receivablesDays) > 2) {
    flag('RECEIVABLES_SPIKE', metrics.receivablesDays?.toFixed(0), zScores.receivablesDays,
      Math.abs(zScores.receivablesDays) > 3 ? 'high' : 'medium',
      `Receivables days (${metrics.receivablesDays?.toFixed(0)}) is ${Math.abs(zScores.receivablesDays).toFixed(1)}σ from average`);
  }

  // 5. Inventory buildup
  if (zScores.inventoryDays != null && Math.abs(zScores.inventoryDays) > 2.5) {
    flag('INVENTORY_BUILDUP', metrics.inventoryDays?.toFixed(0), zScores.inventoryDays, 'medium',
      `Inventory days (${metrics.inventoryDays?.toFixed(0)}) is unusual`);
  }

  // 6. Debt stress
  if (metrics.debtToEquity != null && metrics.debtToEquity > 1.5 &&
      metrics.interestCoverage != null && metrics.interestCoverage < 2) {
    flag('DEBT_STRESS',
      `D/E=${metrics.debtToEquity.toFixed(2)}, Coverage=${metrics.interestCoverage.toFixed(2)}x`,
      zScores.debtToEquity, 'critical',
      `High leverage (D/E=${metrics.debtToEquity.toFixed(2)}) with weak interest coverage (${metrics.interestCoverage.toFixed(1)}x)`);
  }

  // 7. Deteriorating interest coverage
  if (zScores.interestCoverage != null && zScores.interestCoverage < -2) {
    flag('DECLINING_INTEREST_COVERAGE', metrics.interestCoverage?.toFixed(2), zScores.interestCoverage, 'high',
      `Interest coverage (${metrics.interestCoverage?.toFixed(1)}x) is ${Math.abs(zScores.interestCoverage).toFixed(1)}σ below average`);
  }

  // 8. Unusual tax rate
  if (metrics.effectiveTaxRate != null &&
      (metrics.effectiveTaxRate < 0 || metrics.effectiveTaxRate > 0.5)) {
    flag('UNUSUAL_TAX_RATE', (metrics.effectiveTaxRate * 100).toFixed(1) + '%',
      zScores.effectiveTaxRate, 'medium',
      `Effective tax rate of ${(metrics.effectiveTaxRate * 100).toFixed(1)}% is outside normal 20-35% range`);
  }

  // 9. Poor cash conversion
  if (metrics.cashConversionEff != null && metrics.cashConversionEff < 0.5) {
    flag('POOR_CASH_CONVERSION', metrics.cashConversionEff.toFixed(2), zScores.cashConversionEff, 'high',
      `OCF is only ${(metrics.cashConversionEff * 100).toFixed(0)}% of net income`);
  }

  // 10. Declining ROA
  if (zScores.roa != null && zScores.roa < -2) {
    flag('DECLINING_ROA', metrics.roa?.toFixed(2) + '%', zScores.roa, 'high',
      `ROA (${metrics.roa?.toFixed(2)}%) is ${Math.abs(zScores.roa).toFixed(1)}σ below average`);
  }

  // 11. Declining ROE
  if (zScores.roe != null && zScores.roe < -2) {
    flag('DECLINING_ROE', metrics.roe?.toFixed(2) + '%', zScores.roe, 'high',
      `ROE (${metrics.roe?.toFixed(2)}%) is ${Math.abs(zScores.roe).toFixed(1)}σ below average`);
  }

  // 12. Asset efficiency decline
  if (zScores.assetTurnover != null && zScores.assetTurnover < -2) {
    flag('ASSET_EFFICIENCY_DECLINE', metrics.assetTurnover?.toFixed(2), zScores.assetTurnover, 'medium',
      `Asset turnover declining — assets growing faster than revenue`);
  }

  // 13. Receivables growth outpacing revenue growth
  if (metrics.receivablesGrowthVsRevenueGrowth != null && metrics.receivablesGrowthVsRevenueGrowth > 20) {
    flag(
      'RECEIVABLES_GROWTH_VS_REVENUE',
      metrics.receivablesGrowthVsRevenueGrowth.toFixed(2),
      zScores.receivablesGrowthVsRevenueGrowth,
      Math.abs(zScores.receivablesGrowthVsRevenueGrowth ?? 0) > 2.5 ? 'high' : 'medium',
      'Receivables growth is significantly higher than revenue growth'
    );
  }

  // 14. Related party transaction ratio too high
  if (metrics.relatedPartyTransactionPctRevenue != null && metrics.relatedPartyTransactionPctRevenue > 15) {
    flag(
      'RELATED_PARTY_RATIO_HIGH',
      metrics.relatedPartyTransactionPctRevenue.toFixed(2) + '%',
      zScores.relatedPartyTransactionPctRevenue,
      metrics.relatedPartyTransactionPctRevenue > 25 ? 'high' : 'medium',
      'Related party transactions are high as a percentage of revenue'
    );
  }

  // 15. Leverage trend deterioration
  if (metrics.debtToEquityTrend != null && metrics.debtToEquityTrend > 0.2) {
    flag(
      'DEBT_TO_EQUITY_TREND',
      metrics.debtToEquityTrend.toFixed(2),
      zScores.debtToEquityTrend,
      Math.abs(zScores.debtToEquityTrend ?? 0) > 2 ? 'high' : 'medium',
      'Debt-to-equity is rising sharply year over year'
    );
  }

  return anomalies;
}

function calculateAnomalyScore(anomalies) {
  const weights = { critical: 15, high: 8, medium: 3 };
  return Math.min(anomalies.reduce((s, a) => s + (weights[a.severity] || 0), 0), 100);
}

export { computeMetrics }; 