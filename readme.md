# QUANTIRA

### Financial Fraud Detection Platform for Indian Public Companies

> ⚠️ **LEGAL DISCLAIMER** — Please read before use.
>
> QUANTIRA is an independent research and educational tool. The creator is **not registered with SEBI (Securities and Exchange Board of India)** or any other financial regulatory authority. Nothing in this platform constitutes financial advice, investment advice, trading recommendations, or any form of regulated financial service. All output — including anomaly scores, fraud signals, and sector analysis — is for **informational and research purposes only**.
>
> This tool does not recommend buying, selling, or holding any security. Past financial patterns are not indicative of future performance. Users are solely responsible for their own investment decisions. Always consult a SEBI-registered investment advisor before making financial decisions.
>
> Use of this platform implies acceptance of these terms.

---

Detect accounting fraud, earnings manipulation, and financial distress using advanced anomaly detection with sector-aware intelligence — for any NSE/BSE-listed Indian company.

<<<<<<< HEAD
Built in **3 days** at a hackathon | March 2026
=======
Built in **3 days** at a hackathon | March 2026

> > > > > > > 690a67f (Day 3 complete: Add sector benchmarking, update README, and clean up ingestion pipeline. Remove PDF and exchange scrapers. Add demo sector profiles and benchmarking logic.)

---

## Overview

QUANTIRA is an intelligent financial fraud detection system for Indian publicly-traded companies. It ingests 10+ years of historical financials, computes 18+ financial ratios, runs Z-score anomaly detection, and then applies sector-aware filtering to suppress false positives that are normal for a given industry.

The pipeline analyzes any Indian company in ~30 seconds with approximately 40–60% fewer false positives than naive threshold-based methods.

---

## What Was Built

### Day 1 — Data Ingestion Pipeline

- Automated scraping from Screener.in (10–12 years per company)
- Real-time progress tracking via WebSocket
- Async job processing with BullMQ + Redis
- Structured storage in MongoDB with nested schema
- No PDFs required — clean, structured financial data

### Day 2 — Anomaly Detection Engine

<<<<<<< HEAD
18+ financial ratios computed automatically across four categories:

- **Profitability:** Net Margin, Operating Margin, ROA, ROE
- **Leverage:** Debt/Equity, Interest Coverage, Debt/Assets
- **Efficiency:** Receivables Days, Inventory Days, Asset Turnover
- **Quality:** Free Cash Flow/NI, Cash Conversion, Tax Rate
  Z-score analysis is run against each company's own 10-year history
  12 fraud detection rules cover cash flow quality issues, accrual anomalies, margin divergence, debt stress, earnings manipulation signals, and more

### Day 3 — Sector Intelligence (Peer Benchmarking)

- The core differentiator: QUANTIRA evaluates each anomaly in sector context, not just flat rules
- 8 pre-seeded SEBI sector profiles: IT, Pharma, Banking, FMCG, Construction, Energy, Metals, Automotive
- Benchmarks use Median ± 1.5σ thresholds
- Vector DB integration (Chroma/Pinecone) ready for semantic peer search
- # Example:
- 18+ financial ratios computed automatically across four categories:
  - **Profitability:** Net Margin, Operating Margin, ROA, ROE
  - **Leverage:** Debt/Equity, Interest Coverage, Debt/Assets
  - **Efficiency:** Receivables Days, Inventory Days, Asset Turnover
  - **Quality:** Free Cash Flow/NI, Cash Conversion, Tax Rate
- Z-score analysis is run against each company's own 10-year history
- 12 fraud detection rules cover cash flow quality issues, accrual anomalies, margin divergence, debt stress, earnings manipulation signals, and more

### Day 3 — Sector Intelligence (Peer Benchmarking)

- The core differentiator: QUANTIRA evaluates each anomaly in sector context, not just flat rules
- 8 pre-seeded SEBI sector profiles: IT, Pharma, Banking, FMCG, Construction, Energy, Metals, Automotive
- Benchmarks use Median ± 1.5σ thresholds
- Vector DB integration (Chroma/Pinecone) ready for semantic peer search
- Example:
  > > > > > > > 690a67f (Day 3 complete: Add sector benchmarking, update README, and clean up ingestion pipeline. Remove PDF and exchange scrapers. Add demo sector profiles and benchmarking logic.)

| Traditional Approach            | QUANTIRA Approach                                       |
| ------------------------------- | ------------------------------------------------------- |
| "50% revenue growth = RED FLAG" | "50% growth → normal for IT, abnormal for Metals"       |
| "5x leverage = SOLVENCY RISK"   | "5x → normal for Banks (5–15x), abnormal for Tech"      |
| "120 receivables days = FRAUD"  | "120 days → normal for Construction, suspicious for IT" |

<<<<<<< HEAD

=======

> > > > > > > 690a67f (Day 3 complete: Add sector benchmarking, update README, and clean up ingestion pipeline. Remove PDF and exchange scrapers. Add demo sector profiles and benchmarking logic.)

---

## Architecture

```
Client (Frontend)
       ↓
Express.js API Server (Port 5000)
  • POST /api/ingest
  • GET  /api/ingest/company/:id/financials
  • GET  /api/ingest/search?q=name
  • WebSocket /ws
       ↓
BullMQ Job Queue (Redis/Upstash)
  • Async processing, 2 retries, 5s backoff
  • Max 3 concurrent, 5/min rate limit
       ↓
Background Worker (Node.js)
  • Day 1: Scrape → Transform → Store
  • Day 2: Compute metrics → Z-scores → Anomalies
  • Day 3: Filter by sector → Store context
       ↓
MongoDB
  • Companies, Filings, FinancialData, SectorProfiles
       ↓
Data Sources
  • Screener.in (primary)
  • Vector DB (Chroma/Pinecone — ready)
```

**Stack:** Node.js 24 + Express.js · MongoDB (Mongoose) · Upstash Redis · BullMQ · Axios + Cheerio · WebSocket

---

## Quick Start

**Prerequisites:** Node.js 20+, MongoDB Atlas (free tier), Upstash Redis (free tier)

```bash
# 1. Install
cd quantira/backend
npm install

# 2. Configure
cp .env.example .env
# Add MONGODB_URI and REDIS_URL

# 3. Run
npm run dev      # Terminal 1: API server
npm run worker   # Terminal 2: Background worker

# 4. Test
curl -X POST http://localhost:5000/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"query":"Infosys Limited"}'

# Wait ~30 seconds, then fetch results
curl http://localhost:5000/api/ingest/company/[companyId]/financials
```

---

## API Reference

### POST `/api/ingest`

Queue a company for ingestion.

```json
{ "query": "Infosys Limited" }
```

### GET `/api/ingest/company/:id/financials`

Returns 12 years of financial records, each containing:

- `balanceSheet` — assets, liabilities, debt
- `pnl` — revenue, profit, margins
- `cashFlow` — operating CF, free CF
- `computedMetrics` — 18+ ratios
- `zScores` — Z-score per metric
- `anomalyProfile` — flagged metrics with sector context

### GET `/api/ingest/search?q=name`

Search for companies by name.

### GET `/api/ingest/status/:jobId`

Check job progress.

### GET `/api/ingest/queue-stats`

View queue health.

### WebSocket `/ws`

Subscribe to real-time job progress updates.

---

## Sample Output

```json
{
  "year": 2024,
  "computedMetrics": {
    "netMargin": 16.41,
    "operatingMargin": 24.07,
    "debtToEquity": 0.35,
    "interestCoverage": 82.75,
    "roe": 27.92
  },
  "anomalyProfile": {
    "flaggedMetrics": [
      {
        "metric": "CASH_FLOW_QUALITY",
        "status": "suppressed",
        "isNormalForSector": true,
        "reason": "Normal for Information Technology sector"
      }
    ],
    "anomalyScore": 11,
    "redFlags": 0,
    "sector": "IT"
  }
}
```

---

## Supported Sectors

| Sector       | Example Companies              |
| ------------ | ------------------------------ |
| IT           | INFY, TCS, WIPRO, HCLTECH      |
| Pharma       | SUNPHARMA, DRREDDY, CIPLA      |
| Banking      | HDFCBANK, ICICIBANK, SBIN      |
| FMCG         | HINDUNILVR, ITC, NESTLEIND     |
| Construction | DLF, LODHA, ADANIPORTS         |
| Energy       | RELIANCE, NTPC, ONGC           |
| Metals       | TATASTEEL, HINDALCO, VEDL      |
| Automotive   | MARUTI, TATAMOTORS, HEROMOTOCO |

To add a new sector, edit `SECTOR_DEFINITIONS` in `src/services/sectorIntelligence.js`.

---

## Project Structure

```
quantira/
├── backend/
│   └── src/
│       ├── config/database.js
│       ├── models/index.js
│       ├── services/
│       │   ├── anomalyEngine.js
│       │   ├── anomalyEngineV2.js
│       │   ├── sectorIntelligence.js
│       │   ├── ingestionOrchestrator.js
│       │   └── screenersScraper.js
│       ├── jobs/
│       │   ├── ingestionQueue.js
│       │   └── worker.js
│       ├── routes/ingestion.js
│       ├── utils/
│       │   ├── logger.js
│       │   └── helpers.js
│       └── server.js
├── docs/
│   ├── COMPLETION_REPORT.md
│   ├── TESTING_CHECKLIST.md
│   ├── ARCHITECTURE_SUMMARY.md
│   └── DAY3_IMPLEMENTATION_GUIDE.md
└── README.md
```

---

## Performance

| Stage                    | Target        | Achieved |
| ------------------------ | ------------- | -------- |
| Data ingestion           | < 5s/company  | ~2–3s    |
| Metric computation       | < 1s/12 years | ~0.5s    |
| Z-score calculation      | < 1s          | ~0.3s    |
| Anomaly detection        | < 1s          | ~0.5s    |
| Full pipeline            | < 30s         | ~25–30s  |
| False positive reduction | 40–60%        | ~50%     |

---

## Roadmap

- [ ] React frontend dashboard
- [ ] BSE / SEBI / MCA21 additional data sources
- [ ] PDF parsing for annual reports
- [ ] NLP on management discussion & analysis sections
- [ ] Machine learning fraud classifier
- [ ] Watchlist and portfolio tracking
- [ ] Email alerts for new anomalies

---

## Environment Variables

```env
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/quantira
REDIS_URL=redis://default:password@host:port

# Optional: Vector DB
CHROMA_URL=http://localhost:8000
PINECONE_API_KEY=your-key

PORT=5000
NODE_ENV=development
```

---

## License

Built for a hackathon. For educational and research purposes only.

---

## Acknowledgements

Screener.in · MongoDB Atlas · Upstash · SEBI sector classifications

---

_Built in 2 days by Neil — March 2026_
<<<<<<< HEAD

=======

> > > > > > > 690a67f (Day 3 complete: Add sector benchmarking, update README, and clean up ingestion pipeline. Remove PDF and exchange scrapers. Add demo sector profiles and benchmarking logic.)
