#!/usr/bin/env python3
"""Import companies from tlcg_companies_embed.js into Postgres."""
import json, re, subprocess, sys

with open("tlcg_companies_embed.js", "r") as f:
    content = f.read()

match = re.search(r"window\.TLCG_COMPANIES_DATA\s*=\s*(\{[\s\S]*\});", content)
if not match:
    print("No match found")
    sys.exit(1)

data = json.loads(match.group(1))
companies = data.get("companies_data", [])
print(f"Found {len(companies)} companies")

# Add unique constraint first
subprocess.run(["psql", "tlcg_workflow", "-c",
    "ALTER TABLE companies ADD CONSTRAINT IF NOT EXISTS companies_name_key_unique UNIQUE (company_name, company_key)"],
    capture_output=True)

# Build values
parts = []
for co in companies:
    vals = [
        co.get("Ten cong ty", co.get("\u0054\u00ean c\u00f4ng ty", "")),
        co.get("Ma cong ty", co.get("M\u00e3 c\u00f4ng ty", "")),
        co.get("Ma dinh danh", co.get("M\u00e3 \u0111\u1ecbnh danh", "")),
        co.get("Dai dien phap luat", co.get("\u0110\u1ea1i di\u1ec7n ph\u00e1p lu\u1eadt", "")),
        co.get("Email dai dien", co.get("Email \u0110\u1ea1i di\u1ec7n ph\u00e1p lu\u1eadt", "")),
        co.get("Chu ky dai dien", co.get("Ch\u1eef k\u00fd \u0110\u1ea1i di\u1ec7n ph\u00e1p lu\u1eadt", "")),
        co.get("Ke toan truong", co.get("K\u1ebf to\u00e1n tr\u01b0\u1edfng", "")),
        co.get("Email ke toan", co.get("Email K\u1ebf to\u00e1n tr\u01b0\u1edfng", "")),
        co.get("Chu ky ke toan", co.get("Ch\u1eef k\u00fd K\u1ebf to\u00e1n tr\u01b0\u1edfng", "")),
        co.get("Thu quy", co.get("Th\u1ee7 qu\u1ef7", "")),
        co.get("Email thu quy", co.get("Email Th\u1ee7 qu\u1ef7", "")),
        co.get("Chu ky thu quy", co.get("Ch\u1eef k\u00fd Th\u1ee7 qu\u1ef7", "")),
    ]
    escaped = [v.replace("'", "''") if isinstance(v, str) else "" for v in vals]
    parts.append("(" + ",".join(f"'{v}'" for v in escaped) + ")")

sql = (
    "INSERT INTO companies (company_name, company_code, company_key, "
    "legal_rep_name, legal_rep_email, legal_rep_sig_url, "
    "accountant_name, accountant_email, accountant_sig_url, "
    "treasurer_name, treasurer_email, treasurer_sig_url) VALUES "
    + ",".join(parts)
    + " ON CONFLICT (company_name, company_key) DO UPDATE SET "
    "legal_rep_name=EXCLUDED.legal_rep_name, "
    "legal_rep_email=EXCLUDED.legal_rep_email, "
    "accountant_name=EXCLUDED.accountant_name, "
    "accountant_email=EXCLUDED.accountant_email, "
    "treasurer_name=EXCLUDED.treasurer_name, "
    "treasurer_email=EXCLUDED.treasurer_email, "
    "accountant_sig_url=EXCLUDED.accountant_sig_url, "
    "treasurer_sig_url=EXCLUDED.treasurer_sig_url, "
    "legal_rep_sig_url=EXCLUDED.legal_rep_sig_url"
)

result = subprocess.run(["psql", "tlcg_workflow", "-c", sql], capture_output=True, text=True)
if result.returncode == 0:
    print(f"Imported {len(companies)} companies: {result.stdout.strip()}")
else:
    print(f"Error: {result.stderr}")
    sys.exit(1)
