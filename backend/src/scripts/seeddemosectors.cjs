// seeddemosectors.js
// Script to seed sector medians/stddevs for benchmarking

// Replace with real data and DB/vector DB insert
const fs = require('fs');
const path = require('path');

const demoSectors = [
  {
    sector: 'IT',
    metrics: {
      revenueVsCashFlowDivergence: { median: 0.8, stddev: 0.2 },
      debtToEquityTrend: { median: 0.01, stddev: 0.05 },
      // ... add all metrics
    },
    companies: ['CIN1', 'CIN2', 'CIN3'],
  },
  // ... more sectors
];

fs.writeFileSync(
  path.join(__dirname, '../../storage/sectorProfiles.json'),
  JSON.stringify(demoSectors, null, 2)
);
console.log('Demo sector profiles seeded.');
