/**
 * PDF download + storage service
 * Downloads annual report PDFs and stores them locally (or S3 in prod)
 * Implements retry logic and size validation
 */

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { createReadStream } from 'fs';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';
import { getGridFSBucket } from '../config/database.js';

const PDF_DIR = process.env.PDF_STORAGE_PATH || './storage/pdfs';
const MAX_PDF_SIZE = 100 * 1024 * 1024;  // 100MB max
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

// Ensure storage directory exists
if (!existsSync(PDF_DIR)) {
  mkdirSync(PDF_DIR, { recursive: true });
}

/**
 * Generate a deterministic local path for a PDF
 */
export function getPDFPath(companyId, year, source) {
  const dir = path.join(PDF_DIR, companyId.toString());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, `${year}_${source}_annual_report.pdf`);
}

/**
 * Download a PDF from a URL with retry logic
 * Returns { pdfPath, size } or throws
 */
export async function downloadPDF(url, destPath, retries = 3) {
  // Check if already downloaded
  try {
    const stat = await fs.stat(destPath);
    if (stat.size > 1000) {
      logger.debug('PDF already exists, skipping download', { destPath, size: stat.size });
      return { pdfPath: destPath, size: stat.size };
    }
  } catch { /* file doesn't exist, proceed */ }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sleep(DELAY * attempt);
      logger.info(`Downloading PDF (attempt ${attempt})`, { url });

      const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        timeout: 60000,
        maxContentLength: MAX_PDF_SIZE,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/pdf,*/*',
          'Referer': 'https://www.bseindia.com/'
        }
      });

      const contentLength = parseInt(response.headers['content-length'] || '0');
      if (contentLength > MAX_PDF_SIZE) {
        throw new Error(`PDF too large: ${contentLength} bytes`);
      }

      // Check content type
      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('pdf') && !contentType.includes('octet-stream') && !contentType.includes('application')) {
        throw new Error(`Invalid content type: ${contentType}`);
      }

      await new Promise((resolve, reject) => {
        const writer = createWriteStream(destPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });

      const stat = await fs.stat(destPath);
      if (stat.size < 1000) throw new Error('Downloaded file too small, likely an error page');

      logger.info('PDF downloaded', { destPath, size: stat.size });
      return { pdfPath: destPath, size: stat.size };
    } catch (err) {
      logger.warn(`PDF download attempt ${attempt} failed`, { url, error: err.message });
      // Clean up partial file
      try { await fs.unlink(destPath); } catch { /* ignore */ }
      if (attempt === retries) throw err;
    }
  }
}

/**
 * Check if a PDF is already in cache
 */
export async function isPDFCached(destPath) {
  try {
    const stat = await fs.stat(destPath);
    return stat.size > 1000;
  } catch { return false; }
}

/**
 * List all cached PDFs for a company
 */
export async function listCachedPDFs(companyId) {
  const dir = path.join(PDF_DIR, companyId.toString());
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.pdf')).map(f => path.join(dir, f));
  } catch { return []; }
}

/**
 * Upload a local PDF file into MongoDB GridFS
 * Returns the created GridFS ObjectId
 */
export async function uploadPDFToGridFS(localPath, metadata = {}) {
  const bucket = getGridFSBucket();
  if (!bucket) {
    return null;
  }

  const filename = path.basename(localPath);

  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, {
      metadata: {
        ...metadata,
        uploadedAt: new Date()
      }
    });

    createReadStream(localPath)
      .pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => {
        logger.info('PDF uploaded to GridFS', {
          filename,
          gridFsFileId: uploadStream.id.toString()
        });
        resolve(uploadStream.id);
      });
  });
}