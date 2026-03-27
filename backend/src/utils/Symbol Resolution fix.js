/**
 * FIX: Proper symbol resolution with fallback handling
 * 
 * The issue: When searchScreener fails, we were returning
 * the full company name (e.g., "INFOSYS LIMITED") instead of
 * the NSE symbol (e.g., "INFY")
 * 
 * Solution: Use SYMBOL_MAP as primary source, with smart fallback
 */
 
const SYMBOL_MAP = {
  'INFY': 'INFY',
  'INFOSYS': 'INFY',
  'INFOSYS LIMITED': 'INFY',  // ← Add full names as keys
  'INFOSYS LTD': 'INFY',
  
  'TCS': 'TCS',
  'TATA CONSULTANCY': 'TCS',
  'TATA CONSULTANCY SERVICES': 'TCS',
  
  'WIPRO': 'WIPRO',
  
  'HCLTECH': 'HCLTECH',
  'HCL': 'HCLTECH',
  'HCL TECHNOLOGIES': 'HCLTECH',
  
  'RELIANCE': 'RELIANCE',
  'RELIANCE INDUSTRIES': 'RELIANCE',
  'RIL': 'RELIANCE',
  
  'HDFCBANK': 'HDFCBANK',
  'HDFC BANK': 'HDFCBANK',
  'HDFC': 'HDFCBANK',
  
  'ICICIBANK': 'ICICIBANK',
  'ICICI BANK': 'ICICIBANK',
  'ICICI': 'ICICIBANK',
  
  'SBIN': 'SBIN',
  'STATE BANK': 'SBIN',
  'STATE BANK OF INDIA': 'SBIN',
  
  'SUNPHARMA': 'SUNPHARMA',
  'SUN PHARMA': 'SUNPHARMA',
  'SUN PHARMACEUTICAL': 'SUNPHARMA',
  
  'DRREDDY': 'DRREDDY',
  'DR REDDY': 'DRREDDY',
  "DR. REDDY'S": 'DRREDDY',
  
  'TATAMOTORS': 'TATAMOTORS',
  'TATA MOTORS': 'TATAMOTORS',
  
  'TATASTEEL': 'TATASTEEL',
  'TATA STEEL': 'TATASTEEL',
  
  'MARUTI': 'MARUTI',
  'MARUTI SUZUKI': 'MARUTI',
  
  'HINDUNILVR': 'HINDUNILVR',
  'HINDUSTAN UNILEVER': 'HINDUNILVR',
  'HUL': 'HINDUNILVR',
  
  'KOTAKBANK': 'KOTAKBANK',
  'KOTAK BANK': 'KOTAKBANK',
  'KOTAK MAHINDRA': 'KOTAKBANK',
  
  'AXISBANK': 'AXISBANK',
  'AXIS BANK': 'AXISBANK',
  
  'ADANIENT': 'ADANIENT',
  'ADANI ENTERPRISES': 'ADANIENT',
};
 
/**
 * FIXED: Resolve company query to NSE symbol
 * 
 * Priority:
 * 1. Check SYMBOL_MAP (fast, offline)
 * 2. Try Screener API search (if available)
 * 3. Return null (don't use company name as symbol)
 */
async function resolveSymbol(query) {
  const q = query.toUpperCase().trim();
  
  // 1. Check SYMBOL_MAP first (most reliable)
  if (SYMBOL_MAP[q]) {
    logger.info(`Symbol found in map: ${q} → ${SYMBOL_MAP[q]}`);
    return SYMBOL_MAP[q];
  }
  
  // 2. Try Screener search (fallback)
  try {
    const results = await searchScreener(query);
    if (results.length > 0) {
      const symbol = results[0].symbol;
      logger.info(`Symbol found via search: ${query} → ${symbol}`);
      return symbol;
    }
  } catch (error) {
    logger.warn(`Screener search failed: ${error.message}`);
  }
  
  // 3. CRITICAL FIX: Don't return company name as symbol!
  // This was causing "INFOSYS LIMITED" to be used as a URL path
  logger.error(`❌ Cannot resolve symbol for: "${query}"`);
  logger.error(`   Available symbols: ${Object.keys(SYMBOL_MAP).slice(0, 5).join(', ')}...`);
  
  return null;  // ← Return null instead of uppercase query
}
 
/**
 * Update ingestCompany to handle null symbol
 */
async function ingestCompany(query, onProgress = () => {}) {
  logger.info('Starting ingestion via Screener.in', { query });
  onProgress('resolving', 5, `Looking up "${query}"...`);
 
  const symbol = await resolveSymbol(query);
  
  // FIX: Check for null and throw meaningful error
  if (!symbol) {
    const error = `Cannot find company: "${query}". 
    
Available companies by sector:
  IT: INFY (Infosys), TCS, WIPRO, HCL
  Pharma: SUNPHARMA, DRREDDY, CIPLA
  Banking: HDFCBANK, ICICIBANK, SBIN, AXISBANK, KOTAKBANK
  FMCG: HINDUNILVR, ITC
  Energy: RELIANCE, NTPC
  Metals: TATASTEEL, HINDALCO
  Auto: MARUTI, TATAMOTORS
  
Try searching with NSE symbol or full company name from above.`;
    
    logger.error(error);
    throw new Error(error);
  }
 
  logger.info('Symbol resolved', { symbol });
  onProgress('resolving', 15, `Resolved to symbol: ${symbol}`);
 
  // ... rest of function
}
 
export { SYMBOL_MAP, resolveSymbol, ingestCompany };