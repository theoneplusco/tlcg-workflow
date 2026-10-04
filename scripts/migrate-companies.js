// scripts/migrate-companies.js — Import companies from tlcg_companies_embed.js
import fs from 'fs';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

async function main() {
  console.log('[Migrate] Importing companies from tlcg_companies_embed.js');

  let embedContent;
  try {
    embedContent = fs.readFileSync('./tlcg_companies_embed.js', 'utf-8');
  } catch (e) {
    console.error('[Migrate] Cannot read tlcg_companies_embed.js:', e.message);
    process.exit(1);
  }

  // Try to find the JSON data in the file
  // The file defines: var TLCG_COMPANIES_DATA = { companies_data: [...] }
  // or: window.TLCG_COMPANIES_DATA = { ... }

  let companies;

  // Try executing the file in a sandbox-like context
  try {
    // Create a fake window/global context
    const sandbox = { window: {}, btoa: (s) => Buffer.from(s).toString('base64'), atob: (s) => Buffer.from(s, 'base64').toString('utf-8') };
    const fn = new Function('window', 'btoa', 'atob', embedContent + '; return TLCG_COMPANIES_DATA || (typeof window !== "undefined" ? window.TLCG_COMPANIES_DATA : null);');
    const data = fn(sandbox.window, sandbox.btoa, sandbox.atob);
    companies = data?.companies_data || [];
  } catch (e) {
    console.error('[Migrate] Could not parse embed file:', e.message);
    // Fallback: try to extract the JSON array directly
    try {
      const match = embedContent.match(/companies_data\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
      if (match) {
        companies = JSON.parse(match[1]);
      }
    } catch (e2) {
      console.error('[Migrate] Fallback parse also failed:', e2.message);
      process.exit(1);
    }
  }

  if (!companies || !companies.length) {
    console.log('[Migrate] No companies found in embed file');
    await pool.end();
    return;
  }

  console.log(`[Migrate] Found ${companies.length} companies`);

  let count = 0;
  for (const co of companies) {
    try {
      await pool.query(
        `INSERT INTO companies
           (company_name, company_code, company_key,
            legal_rep_name, legal_rep_email, legal_rep_sig_url,
            accountant_name, accountant_email, accountant_sig_url,
            treasurer_name, treasurer_email, treasurer_sig_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (company_name) DO UPDATE SET
           company_code = EXCLUDED.company_code,
           company_key = EXCLUDED.company_key,
           legal_rep_name = EXCLUDED.legal_rep_name,
           legal_rep_email = EXCLUDED.legal_rep_email,
           accountant_name = EXCLUDED.accountant_name,
           accountant_email = EXCLUDED.accountant_email,
           treasurer_name = EXCLUDED.treasurer_name,
           treasurer_email = EXCLUDED.treasurer_email`,
        [
          co.name || co.company_name || co.Company_Name || '',
          co.code || co.company_code || co.Company_Code || '',
          co.key || co.company_key || co.Company_Key_Or_Taxid || '',
          co.legalRep?.name || co.Legal_Representative_Name || '',
          co.legalRep?.email || co.Legal_Representative_Email || '',
          co.legalRep?.signature || co.Legal_Representative_Signature || '',
          co.accountant?.name || co.Chief_Accountant_Name || '',
          co.accountant?.email || co.Chief_Accountant_Email || '',
          co.accountant?.signature || co.Chief_Accountant_Signature || '',
          co.treasurer?.name || co.Treasurer_Name || '',
          co.treasurer?.email || co.Treasurer_Email || '',
          co.treasurer?.signature || co.Treasurer_Signature || '',
        ]
      );
      count++;
    } catch (err) {
      console.error(`[Migrate] Company "${co.name || co.company_name}":`, err.message);
    }
  }

  console.log(`[Migrate] Imported ${count}/${companies.length} companies`);
  await pool.end();
}

main();
