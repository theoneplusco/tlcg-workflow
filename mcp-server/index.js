#!/usr/bin/env node

/**
 * TLCG Workflow MCP Server
 * Tools for diagnosing and managing the Google Apps Script backend,
 * Vercel proxy, and voucher system.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Files that contain GAS URLs (relative to PROJECT_ROOT)
const GAS_URL_FILES = [
  'api/voucher.js',
  'api/voucher/[action].js',
  'approve_voucher.html',
  'reject_voucher.html',
  'approve_voucher.html.bak',
  'script.js',
  'index.html',
  'voucher.html',
];

const GAS_URL_PATTERN = /https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/g;

// ─── Helpers ────────────────────────────────────────────────────────────────

function readProjectFile(relPath) {
  const abs = join(PROJECT_ROOT, relPath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

function writeProjectFile(relPath, content) {
  const abs = join(PROJECT_ROOT, relPath);
  writeFileSync(abs, content, 'utf8');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeUrl(url, method = 'GET', action = null) {
  const isGet = method.toUpperCase() === 'GET';
  const targetUrl = isGet && action ? `${url}?action=${action}` : url;

  let body;
  let headers = { 'User-Agent': 'TLCG-MCP/1.0' };

  if (!isGet && action) {
    const params = new URLSearchParams({ action });
    body = params.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const res = await fetchWithTimeout(targetUrl, { method: isGet ? 'GET' : 'POST', headers, body, redirect: 'follow' });
  const text = await res.text();
  const isHtml = text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().startsWith('<html');

  let parsed = null;
  if (!isHtml) {
    try { parsed = JSON.parse(text); } catch {}
  }

  return {
    status: res.status,
    ok: res.ok,
    isHtml,
    isJson: parsed !== null,
    preview: text.substring(0, 400),
    parsed,
  };
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'probe_gas_url',
    description: 'Send a test request to any Google Apps Script URL and report whether it returns JSON or an HTML error page. Use this to diagnose deployment/auth issues.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The GAS exec URL to probe' },
        action: { type: 'string', description: 'GAS action to test (e.g. getVoucherSummary)' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET', description: 'HTTP method' },
      },
      required: ['url'],
    },
  },
  {
    name: 'test_voucher_backend',
    description: 'Test the voucher Apps Script backend via the proxy or a direct GAS URL (any action). Reports JSON/HTML status and response preview.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['getVoucherSummary', 'getVoucherHistory', 'getEmployees', 'getCompanyApprovers', 'getApprovalStatus'],
          default: 'getVoucherSummary',
          description: 'GAS action to test',
        },
        useProxy: {
          type: 'boolean',
          default: true,
          description: 'If true, calls through the Vercel proxy (/api/voucher). If false, calls GAS directly.',
        },
        directUrl: {
          type: 'string',
          description: 'Direct GAS URL (only used when useProxy=false). Reads from api/voucher.js fallback if omitted.',
        },
        voucherNumber: { type: 'string', description: 'Required only for getVoucherHistory' },
      },
      required: ['action'],
    },
  },
  {
    name: 'find_gas_urls',
    description: 'Scan all project files and list every Google Apps Script URL found, with the file and line number.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_gas_url',
    description: 'Replace an old GAS URL with a new one across all relevant project files (api/voucher.js, api/voucher/[action].js, approve_voucher.html, reject_voucher.html, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        oldUrl: { type: 'string', description: 'The old GAS URL to replace (full exec URL). Leave empty to replace ALL non-TLCGROUP, non-PAYMENT GAS URLs.' },
        newUrl: { type: 'string', description: 'The new GAS exec URL' },
      },
      required: ['newUrl'],
    },
  },
  {
    name: 'read_proxy_config',
    description: 'Show backend URLs wired in api/voucher.js (voucher VOUCHER_BACKEND, TLCGROUP, PAYMENT_REQUEST) and which env vars override them.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'check_vercel_env',
    description: 'List the Vercel environment variables set for this project using the Vercel CLI (vercel env ls).',
    inputSchema: {
      type: 'object',
      properties: {
        environment: {
          type: 'string',
          enum: ['production', 'preview', 'development'],
          default: 'production',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_vercel_logs',
    description: 'Fetch recent Vercel function logs for the /api/voucher route using the Vercel CLI.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', default: 50, description: 'Number of log lines to return' },
      },
      required: [],
    },
  },
  {
    name: 'read_gas_backend',
    description: 'Read a section of TLCG_CASH_BACKEND.gs by function name or line range, useful for checking what a specific handler does.',
    inputSchema: {
      type: 'object',
      properties: {
        functionName: { type: 'string', description: 'Name of the GAS function to find and return (e.g. handleGetVoucherSummary)' },
        startLine: { type: 'number', description: 'Start line (1-based)' },
        endLine: { type: 'number', description: 'End line (1-based)' },
      },
      required: [],
    },
  },
];

// ─── Tool Handlers ───────────────────────────────────────────────────────────

async function handleProbGasUrl({ url, action, method = 'GET' }) {
  try {
    const result = await probeUrl(url, method, action);
    const lines = [
      `URL: ${url}`,
      `Method: ${method}${action ? ` | Action: ${action}` : ''}`,
      `HTTP Status: ${result.status} (${result.ok ? 'OK' : 'NOT OK'})`,
      `Response type: ${result.isHtml ? '❌ HTML (error page)' : result.isJson ? '✅ JSON' : '⚠️ Unknown'}`,
      '',
      '── Response preview ──',
      result.preview,
    ];
    if (result.isJson && result.parsed) {
      lines.push('', '── Parsed JSON ──');
      lines.push(JSON.stringify(result.parsed, null, 2).substring(0, 800));
    }
    if (result.isHtml) {
      lines.push('', '⚠️  GAS is returning HTML. Possible causes:');
      lines.push('  1. Deployment URL is wrong or expired — create a new deployment and update the URL');
      lines.push('  2. Script needs re-authorization — go to script.google.com, run any function, click Allow');
      lines.push('  3. POST request is being redirected to GET — use GET for read-only actions');
    }
    return lines.join('\n');
  } catch (err) {
    return `❌ Request failed: ${err.message}`;
  }
}

async function handleTestVoucherBackend({ action, useProxy = true, directUrl, voucherNumber }) {
  try {
    let url;
    let method = 'GET';

    if (useProxy) {
      url = 'https://wf.tl-c.us/api/voucher';
    } else {
      if (directUrl) {
        url = directUrl;
      } else {
        const proxyContent = readProjectFile('api/voucher.js');
        const match = proxyContent?.match(GAS_URL_PATTERN);
        url = match ? match[0] : null;
        if (!url) return '❌ Could not find GAS URL in api/voucher.js. Please provide directUrl.';
      }
    }

    let targetUrl = useProxy
      ? `${url}?action=${action}${voucherNumber ? `&voucherNumber=${encodeURIComponent(voucherNumber)}` : ''}`
      : `${url}?action=${action}${voucherNumber ? `&voucherNumber=${encodeURIComponent(voucherNumber)}` : ''}`;

    const result = await probeUrl(targetUrl, 'GET');

    const lines = [
      `Backend: ${useProxy ? 'Via Vercel proxy' : 'Direct GAS'}`,
      `URL: ${targetUrl}`,
      `HTTP Status: ${result.status}`,
      `Response type: ${result.isHtml ? '❌ HTML error page' : result.isJson ? '✅ JSON' : '⚠️ Unknown'}`,
      '',
    ];

    if (result.isJson && result.parsed) {
      lines.push(`success: ${result.parsed.success}`);
      if (result.parsed.message) lines.push(`message: ${result.parsed.message}`);
      if (result.parsed.data) {
        const data = result.parsed.data;
        if (data.total !== undefined) {
          lines.push(`total vouchers: ${data.total}`);
          lines.push(`pending: ${data.pending} | approved: ${data.approved} | rejected: ${data.rejected}`);
          lines.push(`recent records returned: ${(data.recent || []).length}`);
        } else {
          lines.push('data: ' + JSON.stringify(data, null, 2).substring(0, 600));
        }
      }
    } else {
      lines.push('── Response preview ──');
      lines.push(result.preview);
    }

    return lines.join('\n');
  } catch (err) {
    return `❌ Test failed: ${err.message}`;
  }
}

function handleFindGasUrls() {
  const results = [];

  for (const relPath of GAS_URL_FILES) {
    const content = readProjectFile(relPath);
    if (!content) continue;

    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      const matches = line.match(GAS_URL_PATTERN);
      if (matches) {
        matches.forEach(url => {
          results.push({ file: relPath, line: idx + 1, url });
        });
      }
    });
  }

  if (!results.length) return 'No GAS URLs found in project files.';

  // Group by URL
  const byUrl = {};
  for (const r of results) {
    if (!byUrl[r.url]) byUrl[r.url] = [];
    byUrl[r.url].push(`  ${r.file}:${r.line}`);
  }

  const lines = ['GAS URLs found in project:\n'];
  for (const [url, locations] of Object.entries(byUrl)) {
    lines.push(`🔗 ${url}`);
    lines.push(...locations);
    lines.push('');
  }
  return lines.join('\n');
}

function handleUpdateGasUrl({ oldUrl, newUrl }) {
  if (!newUrl.match(/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/)) {
    return '❌ Invalid GAS URL format. Expected: https://script.google.com/macros/s/DEPLOYMENT_ID/exec';
  }

  const updated = [];
  const skipped = [];

  for (const relPath of GAS_URL_FILES) {
    const content = readProjectFile(relPath);
    if (!content) { skipped.push(`${relPath} (not found)`); continue; }

    let newContent;
    if (oldUrl) {
      if (!content.includes(oldUrl)) { skipped.push(`${relPath} (URL not present)`); continue; }
      newContent = content.split(oldUrl).join(newUrl);
    } else {
      // Replace all GAS URLs that are NOT the TLCGROUP or PAYMENT_REQUEST backend.
      // These deployment IDs must be kept in step with the ones in
      // api/voucher.js — if they go stale this guard stops matching and the
      // bulk update would overwrite the CORE/P2P URLs too.
      const TLCGROUP = 'AKfycbwoHjoTtE4rPATdp1LO1Of25mSRPm8HVWwbOEgrDpZ07VEz7o38_8Icb1rl235N9VEXnQ';
      const PAYMENT  = 'AKfycbypmldIGhl4c7XW4I0-MaAHPOkuEnNygoCZozsnetmHk0DEgE6WVkcRAc4IGZ4vqYnw';
      const matches = content.match(GAS_URL_PATTERN) || [];
      const toReplace = matches.filter(u => !u.includes(TLCGROUP) && !u.includes(PAYMENT) && u !== newUrl);
      if (!toReplace.length) { skipped.push(`${relPath} (no matching URLs)`); continue; }
      newContent = content;
      toReplace.forEach(u => { newContent = newContent.split(u).join(newUrl); });
    }

    writeProjectFile(relPath, newContent);
    updated.push(relPath);
  }

  const lines = [];
  if (updated.length) {
    lines.push(`✅ Updated ${updated.length} file(s):`);
    updated.forEach(f => lines.push(`  • ${f}`));
  }
  if (skipped.length) {
    lines.push(`\n⏭  Skipped ${skipped.length} file(s):`);
    skipped.forEach(f => lines.push(`  • ${f}`));
  }
  lines.push(`\nNew URL: ${newUrl}`);
  return lines.join('\n');
}

function handleReadProxyConfig() {
  const content = readProjectFile('api/voucher.js');
  if (!content) return '❌ api/voucher.js not found';

  const lines = content.split('\n');
  const relevant = [];
  let capture = false;

  for (const line of lines) {
    if (line.includes('TLCG_CASH_BACKEND') || line.includes('TLCG_CORE_BACKEND') || line.includes('TLCG_P2P_BACKEND') ||
        line.includes('VOUCHER_BACKEND') || line.includes('TLCGROUP_BACKEND') || line.includes('PAYMENT_REQUEST_BACKEND')) {
      capture = true;
    }
    if (capture) {
      relevant.push(line);
      if (line.trim().endsWith(';') || line.trim().endsWith("',")) capture = false;
    }
  }

  const output = [
    'Current backend URLs in api/voucher.js:',
    '(env var overrides the hardcoded fallback when set in Vercel)',
    '',
    ...relevant.filter(l => l.trim()),
    '',
    'Env var names to set in Vercel (canonical):',
    '  TLCG_CASH_BACKEND_URL → TLCG_CASH_BACKEND.gs  (vouchers, cash book)',
    '  TLCG_CORE_BACKEND_URL → TLCG_CORE_BACKEND.gs  (login, getMasterData)',
    '  TLCG_P2P_BACKEND_URL  → TLCG_P2P_BACKEND.gs   (purchase & payment requests)',
    'Legacy fallbacks (still accepted):',
    '  VOUCHER_BACKEND_URL, TLCGROUP_BACKEND_URL, PAYMENT_REQUEST_BACKEND_URL',
  ];
  return output.join('\n');
}

async function handleCheckVercelEnv({ environment = 'production' }) {
  const { execSync } = await import('child_process');
  try {
    const out = execSync(`vercel env ls --environment ${environment} 2>&1`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });
    return `Vercel env vars (${environment}):\n\n${out}`;
  } catch (err) {
    return `❌ vercel env ls failed: ${err.message}\n\nMake sure you're logged in: run "vercel login" in the project directory.`;
  }
}

async function handleGetVercelLogs({ lines = 50 }) {
  const { execSync } = await import('child_process');
  try {
    const out = execSync(`vercel logs --limit ${lines} 2>&1`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 20000,
    });
    return `Recent Vercel logs:\n\n${out}`;
  } catch (err) {
    return `❌ vercel logs failed: ${err.message}`;
  }
}

function handleReadGasBackend({ functionName, startLine, endLine }) {
  const content = readProjectFile('TLCG_CASH_BACKEND.gs');
  if (!content) return '❌ TLCG_CASH_BACKEND.gs not found';

  const allLines = content.split('\n');

  if (functionName) {
    const fnIndex = allLines.findIndex(l => l.includes(`function ${functionName}`));
    if (fnIndex === -1) return `❌ Function "${functionName}" not found in TLCG_CASH_BACKEND.gs`;

    // Capture from function start until matching closing brace
    let braceDepth = 0;
    let started = false;
    const captured = [];
    for (let i = fnIndex; i < allLines.length; i++) {
      const l = allLines[i];
      captured.push(`${i + 1}| ${l}`);
      for (const ch of l) {
        if (ch === '{') { braceDepth++; started = true; }
        if (ch === '}') braceDepth--;
      }
      if (started && braceDepth === 0) break;
      if (captured.length > 150) { captured.push('... (truncated)'); break; }
    }
    return `Function ${functionName} (line ${fnIndex + 1}):\n\n${captured.join('\n')}`;
  }

  if (startLine && endLine) {
    const slice = allLines.slice(startLine - 1, endLine);
    return slice.map((l, i) => `${startLine + i}| ${l}`).join('\n');
  }

  return '❌ Provide either functionName or startLine+endLine';
}

// ─── Server Setup ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'TLCG Workflow Tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case 'probe_gas_url':         result = await handleProbGasUrl(args); break;
      case 'test_voucher_backend':  result = await handleTestVoucherBackend(args); break;
      case 'find_gas_urls':         result = handleFindGasUrls(); break;
      case 'update_gas_url':        result = handleUpdateGasUrl(args); break;
      case 'read_proxy_config':     result = handleReadProxyConfig(); break;
      case 'check_vercel_env':      result = await handleCheckVercelEnv(args); break;
      case 'get_vercel_logs':       result = await handleGetVercelLogs(args); break;
      case 'read_gas_backend':      result = handleReadGasBackend(args); break;
      default: result = `❌ Unknown tool: ${name}`;
    }
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `❌ Tool error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
