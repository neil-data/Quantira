// benchmarkingService.js
// Compares company metrics to sector medians and suppresses/downgrades flags if within normal range

const getSectorProfile = require('../models/SectorProfile'); // Replace with DB/vector DB fetch

/**
 * Benchmarks anomaly flags against sector medians
 * @param {string} sector - Sector name
 * @param {Array} flaggedMetrics - [{ metric, value, zScore, ... }]
 * @returns {Array} - Updated flaggedMetrics with suppressed/downgraded flags
 */
async function benchmarkAnomalies(sector, flaggedMetrics) {
  // TODO: Replace with Chroma/Pinecone fetch
  const sectorProfile = await getSectorProfile(sector);
  if (!sectorProfile) return flaggedMetrics;

  return flaggedMetrics.map(flag => {
    const sectorMetric = sectorProfile.metrics[flag.metric];
    if (!sectorMetric || typeof flag.value !== 'number') return flag;
    const { median, stddev } = sectorMetric;
    const lower = median - 1.5 * stddev;
    const upper = median + 1.5 * stddev;
    if (flag.value >= lower && flag.value <= upper) {
      return { ...flag, severity: 'normal', reason: (flag.reason || '') + ' (normal for sector)' };
    }
    return flag;
  });
}

module.exports = { benchmarkAnomalies };
