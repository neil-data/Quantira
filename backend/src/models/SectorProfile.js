// SectorProfile.js
// Schema for sector medians and stddevs for benchmarking

module.exports = {
  sector: String, // e.g. 'IT', 'Pharma', etc.
  metrics: {
    // metricName: { median: Number, stddev: Number }
  },
  companies: [String], // CINs or company names used for sample
};
