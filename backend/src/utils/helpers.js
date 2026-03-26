/**
 * Shared utility helpers
 */

/**
 * Sleep for given milliseconds
 */
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Normalise a company name for fuzzy matching
 * "Infosys Limited" → "infosys limited"
 * "Tata Consultancy Services Ltd." → "tata consultancy services ltd"
 */
export function normalizeCompanyName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b(limited|ltd\.?|pvt\.?|private|public|inc\.?|corp\.?|llp)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate year-over-year growth rate
 */
export function calcGrowthRate(current, previous) {
  if (!current || !previous || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Calculate Z-score of a value within an array
 */
export function calcZScore(value, arr) {
  const filtered = arr.filter(v => v !== null && v !== undefined);
  if (filtered.length < 3) return null;
  const mean = filtered.reduce((a, b) => a + b, 0) / filtered.length;
  const stdDev = Math.sqrt(
    filtered.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / filtered.length
  );
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

/**
 * Safe division — returns null if denominator is 0 or null
 */
export function safeDivide(num, den) {
  if (den === null || den === undefined || den === 0) return null;
  if (num === null || num === undefined) return null;
  return num / den;
}

/**
 * Clamp a number between min and max
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Format a number as ₹ Crore with Indian comma style
 */
export function formatCrore(num) {
  if (num === null || num === undefined) return 'N/A';
  return `₹${num.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;
}

/**
 * Extract fiscal year from a date string
 */
export function getFiscalYear(dateStr) {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  // Indian FY: April to March. Filing in Apr-Dec = FY of that year
  return month >= 4 ? year : year - 1;
}

/**
 * Chunk an array into batches
 */
export function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Retry an async function N times with exponential backoff
 */
export async function retry(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
}