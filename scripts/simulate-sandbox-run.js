#!/usr/bin/env node
/*
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-hubspot-commission-clawback-churn-reconciliation-calculator.
 *
 * Zero dependencies and zero network modules: only fs, path and vm are
 * required. Code-node JavaScript is taken verbatim from workflow.json and run
 * in isolated VM contexts by a small engine that follows workflow.json's
 * connections, evaluates IF / HTTP {{ expressions }}, emulates HTTP
 * pagination (updateAParameterInEachRequest) and the Read/Write Files node.
 * HTTP nodes are routed to an in-memory HubSpot mock that really evaluates
 * the search filterGroups, so a wrong search body fails the tests.
 *
 * Verifies: structure and static safety, safe defaults, config validation,
 * period resolution, webhook auth, fixture parity, exact money / date
 * parsing, every 90-day clawback scenario against an independent reference
 * calculation, all policies (linear / tiered / full, inclusive / exclusive,
 * anchors, collected-cash retention, computed commission, de minimis), guards,
 * CSV correctness (RFC 4180, formula-injection guard, checksums), live search
 * pagination and fail-closed limits, export + stamp ordering, and idempotency.
 *
 * Usage:  node scripts/simulate-sandbox-run.js [--quiet]
 * Exit:   0 when every check passes, 1 otherwise.
 * Output: sim-output/ (git-ignored): DRAFT payroll / audit CSVs, manifest,
 *         and reports from the sandbox and mocked live runs.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

globalThis.fetch = () => { throw new Error('Network access is not allowed in the simulator'); };

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const FIXTURE_PATH = path.join(ROOT, 'sample-payloads', 'closed-lost-churn-fixture.json');
const OUT_DIR = path.join(ROOT, 'sim-output');
const QUIET = process.argv.includes('--quiet');

const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; if (!QUIET) console.log(`  ✔ ${label}`); }
  else { failed++; failures.push(label + (detail ? ` -- ${detail}` : '')); console.log(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => { if (!QUIET) console.log(`\n▶ ${t}`); };

// ===================================================================== mocks
const TOKENS = { HUBSPOT_ACCESS_TOKEN: 'sim-placeholder-hubspot-token', WEBHOOK_SHARED_SECRET: 'sim-placeholder-webhook-secret-0123456789' };
class HttpError extends Error { constructor(status, message) { super(`${status} - ${message}`); this.status = status; } }
const toMs = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00Z');
  if (/^\d{12,14}$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};
function matches(deal, f) {
  const v = deal.properties[f.propertyName];
  if (f.operator === 'HAS_PROPERTY') return v !== undefined && v !== null && String(v) !== '';
  if (f.operator === 'EQ') return String(v ?? '') === String(f.value);
  const a = toMs(v);
  const b = Number(f.value);
  if (a === null) return false;
  if (f.operator === 'GTE') return a >= b;
  if (f.operator === 'LT') return a < b;
  throw new HttpError(400, `mock does not support operator ${f.operator}`);
}
function makeMocks(opts = {}) {
  const state = { calls: [], stamped: {}, files: {} };
  const dealsById = new Map((opts.deals || fixture.deals).map((d) => [d.id, clone(d)]));
  const invoiceIndex = {};
  for (const [dealId, invs] of Object.entries(fixture.invoicesByDeal)) for (const inv of invs) invoiceIndex[inv.id] = { dealId, inv };
  function handle({ method, url, headers, body, node }) {
    const u = new URL(url);
    state.calls.push({ node, method, path: u.pathname, body: clone(body) });
    if (u.host !== 'api.hubapi.com') throw new HttpError(502, 'unmocked host ' + u.host);
    if (headers.Authorization !== `Bearer ${TOKENS.HUBSPOT_ACCESS_TOKEN}`) throw new HttpError(401, 'bad token');
    if (method === 'POST' && u.pathname === '/crm/v3/objects/deals/search') {
      if (opts.failSearch) throw new HttpError(500, 'search unavailable');
      if (!body.filterGroups || body.filterGroups.length > 5 || body.filterGroups.reduce((n, g) => n + g.filters.length, 0) > 18) throw new HttpError(400, 'VALIDATION_ERROR filter limits');
      if (body.limit > 200) throw new HttpError(400, 'limit > 200');
      const all = [...dealsById.values()].map((d) => { const out = clone(d); Object.assign(out.properties, state.stamped[d.id] || {}); return out; })
        .filter((d) => body.filterGroups.some((g) => g.filters.every((f) => matches(d, f))))
        .sort((a, b) => Number(a.id) - Number(b.id));
      const total = opts.fakeTotal || all.length;
      const start = Number(body.after || 0);
      if (start >= 10000) throw new HttpError(400, 'cannot page beyond 10,000');
      const page = all.slice(start, start + body.limit).map((d) => ({ id: d.id, properties: Object.fromEntries(body.properties.map((k) => [k, d.properties[k] ?? null])) }));
      const next = opts.endlessPaging || start + body.limit < all.length ? { next: { after: String(start + body.limit) } } : undefined;
      return { total, results: page, ...(next ? { paging: next } : {}) };
    }
    if (method === 'POST' && u.pathname === '/crm/v4/associations/deals/invoices/batch/read') {
      if (opts.failInvoices) throw new HttpError(403, 'MISSING_SCOPES crm.objects.invoices.read');
      const results = [];
      for (const { id } of body.inputs) {
        const invs = fixture.invoicesByDeal[id] || [];
        if (invs.length) results.push({ from: { id }, to: invs.map((i) => ({ toObjectId: Number(i.id), associationTypes: [] })) });
      }
      return { status: 'COMPLETE', results };
    }
    if (method === 'POST' && u.pathname === '/crm/v3/objects/invoices/batch/read') {
      return { status: 'COMPLETE', results: body.inputs.map(({ id }) => invoiceIndex[id] && invoiceIndex[id].inv).filter(Boolean) };
    }
    if (method === 'POST' && u.pathname === '/crm/v3/objects/deals/batch/update') {
      if (opts.failStamp) return { status: 'COMPLETE', results: [], errors: body.inputs.map((i) => ({ message: `property validation failed for ${i.id}` })) };
      for (const i of body.inputs) state.stamped[i.id] = { ...(state.stamped[i.id] || {}), ...i.properties };
      return { status: 'COMPLETE', results: body.inputs.map((i) => ({ id: i.id, properties: i.properties })) };
    }
    throw new HttpError(404, `unmocked route ${method} ${u.pathname}`);
  }
  function writeFile(p, base64) {
    if (opts.failWrite) throw new Error(`EACCES: permission denied, open '${p}'`);
    state.files[p] = Buffer.from(base64, 'base64').toString('utf8');
  }
  return { state, handle, writeFile };
}

// ==================================================================== engine
function evalExpr(template, ctx) {
  if (typeof template !== 'string' || !template.startsWith('=')) return template;
  const t = template.slice(1);
  const run = (expr) => vm.runInNewContext(`(${expr})`, { ...ctx, encodeURIComponent, JSON, String, Object, Number }, { timeout: 2000 });
  const single = t.match(/^\{\{([\s\S]*)\}\}$/);
  if (single && !single[1].includes('}}')) return run(single[1]);
  return t.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const v = run(e); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
}
function runWorkflow({ trigger = 'manual', webhookItem, env = {}, mocks }) {
  const runData = {};
  const envProxy = new Proxy({}, { get(_t, k) { if (env === 'BLOCKED') throw new Error('access to env vars denied'); return typeof k === 'string' ? env[k] : undefined; } });
  const accessor = (name) => {
    const runs = runData[name];
    if (!runs || !runs.length) throw new Error(`Referenced node "${name}" has not executed`);
    const items = (runs[runs.length - 1][0] || []).map(clone);
    return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
  };
  const ctxFor = (item) => ({ $json: clone(item.json), $: accessor, $env: envProxy });
  function exec(name, items) {
    const node = byName[name];
    let outputs;
    switch (node.type) {
      case 'n8n-nodes-base.manualTrigger': case 'n8n-nodes-base.webhook': case 'n8n-nodes-base.scheduleTrigger':
        outputs = [items]; break;
      case 'n8n-nodes-base.code': {
        const sandbox = {
          $input: { first: () => clone(items[0]), all: () => items.map(clone), item: clone(items[0]) },
          $env: envProxy, $: accessor, Buffer,
          require: (m) => { throw new Error(`Cannot find module '${m}'`); },
          console: { log() {}, warn() {}, error() {} },
        };
        const res = vm.runInNewContext(`(() => {\n${node.parameters.jsCode}\n})()`, sandbox, { timeout: 20000, filename: `${name}.js` });
        if (!Array.isArray(res)) throw new Error(`Code node "${name}" did not return an array`);
        outputs = [res.map((i) => clone({ json: i.json, ...(i.binary ? { binary: i.binary } : {}) }))];
        break;
      }
      case 'n8n-nodes-base.if': {
        const t = [], f = [];
        for (const it of items) (evalExpr(node.parameters.conditions.conditions[0].leftValue, ctxFor(it)) === true ? t : f).push(it);
        outputs = [t, f]; break;
      }
      case 'n8n-nodes-base.httpRequest': {
        const out = [];
        const pg = node.parameters.options && node.parameters.options.pagination && node.parameters.options.pagination.pagination;
        for (const it of items) {
          const c = ctxFor(it);
          const url = evalExpr(node.parameters.url, c);
          const headers = Object.fromEntries((node.parameters.headerParameters?.parameters || []).map((h) => [h.name, evalExpr(h.value, c)]));
          let body = node.parameters.sendBody ? JSON.parse(evalExpr(node.parameters.jsonBody, c)) : undefined;
          const send = () => mocks.handle({ method: node.parameters.method || 'GET', url, headers, body, node: name });
          try {
            if (!pg) { out.push({ json: send() }); continue; }
            for (let n = 0; n < pg.maxRequests; n++) {
              const resp = send();
              out.push({ json: resp });
              const rc = { ...c, $response: { body: resp } };
              if (evalExpr(pg.completeExpression, rc) === true) break;
              for (const prm of pg.parameters.parameters) if (prm.type === 'body') body = { ...body, [prm.name]: evalExpr(prm.value, rc) };
            }
          } catch (e) {
            if (node.onError === 'continueRegularOutput') out.push({ json: { error: { message: e.message, status: e.status } } });
            else throw Object.assign(new Error(`${name}: ${e.message}`), { node: name });
          }
        }
        outputs = [out]; break;
      }
      case 'n8n-nodes-base.readWriteFile': {
        const out = [];
        for (const it of items) {
          const p = evalExpr(node.parameters.fileName, ctxFor(it));
          mocks.writeFile(p, it.binary[node.parameters.dataPropertyName].data);
          out.push({ json: { ...it.json, fileName: p }, binary: it.binary });
        }
        outputs = [out]; break;
      }
      default: throw new Error(`Engine does not support ${node.type}`);
    }
    (runData[name] = runData[name] || []).push(outputs.map((o) => (o || []).map(clone)));
    const conns = (workflow.connections[name] || {}).main || [];
    outputs.forEach((o, idx) => { if (o && o.length) for (const cn of conns[idx] || []) exec(cn.node, o); });
  }
  let error = null;
  try {
    if (trigger === 'webhook') exec('Reconciliation Webhook', [{ json: webhookItem }]);
    else if (trigger === 'schedule') exec('Monthly Schedule (3rd, 04:23)', [{ json: {} }]);
    else exec('Manual Test Trigger', [{ json: {} }]);
  } catch (e) { error = e; }
  const last = (n) => (runData[n] ? runData[n][runData[n].length - 1][0].map((i) => i.json) : undefined);
  const lastItems = (n) => (runData[n] ? runData[n][runData[n].length - 1][0] : undefined);
  return { runData, error, last, lastItems, mocks };
}

// ------------------------------------------------------------- reference
// Independent reference clawback (floating point, rounded to cents at the
// end), used to cross-check the workflow's exact BigInt implementation.
function reference(dealId, role, { rate = (d) => Math.max(0, 90 - d) / 90, fx = { USD: 1, EUR: 1.08, JPY: 0.0067 }, collected = 1 } = {}) {
  const d = fixture.deals.find((x) => x.id === dealId).properties;
  const startStr = d.contract_start_date || d.hs_date_entered_closedwon;
  const startMs = /^\d+$/.test(startStr) ? Number(startStr) : Date.parse(startStr.slice(0, 10) + 'T00:00:00Z');
  const churnStr = d.churn_date || d.hs_date_entered_closedlost;
  const days = Math.round((Date.parse(churnStr.slice(0, 10) + 'T00:00:00Z') - Math.floor(startMs / 864e5) * 864e5) / 864e5);
  const paid = Number(role === 'AE' ? d.ae_commission_paid : d.sdr_commission_paid);
  const inUsd = Math.round(paid * fx[d.deal_currency_code] * 100) / 100;
  return { days, amount: -(Math.round(inUsd * rate(days) * collected * 100 + 1e-7) / 100) };
}

// -------------------------------------------------------------- env sets
const NOW = '2026-11-17T08:00:00.000Z';
const LIVE = { SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: TOKENS.HUBSPOT_ACCESS_TOKEN, HUBSPOT_PORTAL_ID: '99000001', NOW_OVERRIDE: NOW, RECONCILIATION_PERIOD: '2026-10', FX_RATES: 'EUR:1.08,GBP:1.27,JPY:0.0067', FX_RATES_AS_OF: '2026-10-31', REP_PAYROLL_REF_MAP: '99100001:EMP-SYN-0001,99200001:EMP-SYN-0101,99200002:EMP-SYN-0102', WEBHOOK_SHARED_SECRET: TOKENS.WEBHOOK_SHARED_SECRET };
const ARMED = { ...LIVE, DRY_RUN: 'false', CSV_EXPORT_ENABLED: 'true', HUBSPOT_MUTATIONS_ENABLED: 'true', CSV_EXPORT_DIR: '/data/exports' };
const CLEAN_IDS = ['990010001', '990010002', '990010003', '990010004', '990010005', '990010006', '990010007', '990010009', '990010010', '990010011', '990010015'];
const cleanDeals = fixture.deals.filter((d) => CLEAN_IDS.includes(d.id));
const SB = (extra = {}) => runWorkflow({ env: { NOW_OVERRIDE: NOW, ...extra }, mocks: makeMocks() });
const calcOf = (r) => r.last('Clawback Calculator')[0];
const rowOf = (c, dealId, role) => c.rows.find((r) => r.dealId === dealId && r.role === role);
const dealOf = (c, dealId) => c.deals.find((d) => d.dealId === dealId);
const fileOf = (r, kind) => (r.last('CSV Builder & Integrity') || []).find((f) => f.kind === kind);

// ====================================================================== main
(function main() {
  console.log('n8n-hubspot-commission-clawback-churn-reconciliation-calculator :: offline simulator');
  console.log(`workflow: workflow.json (${workflow.nodes.length} nodes)`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ----------------------------------------------------------- 1. structure
  section('1. Workflow structure and static safety checks');
  const names = workflow.nodes.map((n) => n.name);
  check('Node names are unique', new Set(names).size === names.length);
  check('Workflow is inactive on import', workflow.active === false);
  const bad = [];
  for (const [s, c] of Object.entries(workflow.connections)) { if (!byName[s]) bad.push(s); for (const b of c.main || []) for (const x of b) if (!byName[x.node]) bad.push(`${s}->${x.node}`); }
  check('All connections reference existing nodes', bad.length === 0, bad.join(', '));
  const ifs = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.if');
  check(`All ${ifs.length} IF nodes wire both outputs`, ifs.every((n) => (workflow.connections[n.name]?.main || []).length === 2 && workflow.connections[n.name].main.every((b) => b.length)));
  const reach = new Set();
  const walk = (n) => { if (reach.has(n)) return; reach.add(n); for (const b of workflow.connections[n]?.main || []) for (const c of b) walk(c.node); };
  ['Manual Test Trigger', 'Reconciliation Webhook', 'Monthly Schedule (3rd, 04:23)'].forEach(walk);
  const unreach = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !reach.has(n.name)).map((n) => n.name);
  check('Every functional node is reachable from a trigger', unreach.length === 0, unreach.join(', '));
  check('Manual, webhook (POST, immediate response) and monthly schedule triggers exist', byName['Reconciliation Webhook'].parameters.httpMethod === 'POST' && byName['Reconciliation Webhook'].parameters.responseMode === 'onReceived' && !!byName['Monthly Schedule (3rd, 04:23)']);
  const http = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  check(`All ${http.length} HTTP nodes authenticate only via {{ $env.HUBSPOT_ACCESS_TOKEN }}`, http.every((n) => (n.parameters.headerParameters.parameters.find((h) => h.name === 'Authorization') || {}).value === '=Bearer {{ $env.HUBSPOT_ACCESS_TOKEN }}'));
  check('No stored n8n credentials', workflow.nodes.every((n) => !n.credentials));
  const codeSrc = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => [n.name, n.parameters.jsCode]);
  const writers = codeSrc.filter(([, s]) => /batch\/update|\/batch\/(create|upsert|archive)|PATCH|DELETE/.test(s)).map(([n]) => n);
  check('Only "Build Deal Stamp Batches" builds a CRM write request', writers.length === 1 && writers[0] === 'Build Deal Stamp Batches', writers.join(', '));
  check('Search node fails the run on error (no continue-on-fail)', !byName['HubSpot: Search Churned Deals'].onError);
  check('File-write node stops the run on error (no stamp after a failed export)', !byName['Write CSV Files to Disk'].onError);
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const PAT = [[/pat-(na|eu|ap)\d?-[0-9a-f-]{20,}/i, 'HubSpot token'], [/xox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'], [/sk-[A-Za-z0-9]{20,}/, 'API key'], [/Bearer [A-Za-z0-9\-_.]{16,}/, 'literal bearer'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/, 'IBAN-like'], [/\b\d{3}-\d{2}-\d{4}\b/, 'SSN-like'], [/\b(routing|account)[ _-]?(number|no)\b/i, 'bank account field']];
  const texts = { 'workflow.json': raw };
  for (const f of ['README.md', 'DISCLAIMER.md', '.env.example', 'sample-payloads/closed-lost-churn-fixture.json']) if (fs.existsSync(path.join(ROOT, f))) texts[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const hits = [];
  for (const [f, t] of Object.entries(texts)) for (const [re, l] of PAT) if (re.test(t)) hits.push(`${l} in ${f}`);
  check('No tokens, keys, IBAN / SSN / bank-account data in shipped files', hits.length === 0, hits.join(', '));
  const emails = [...new Set((raw + texts['sample-payloads/closed-lost-churn-fixture.json']).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
  check('Any email address in workflow/fixture uses example.com / example.invalid', emails.every((e) => /@([a-z0-9-]+\.)*example\.(com|invalid)$/i.test(e)), emails.join(','));
  const exprErr = [];
  const visit = (v, w) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { try { new Function('$json', '$', '$env', '$response', `return (${m[1]});`); } catch (e) { exprErr.push(`${w}: ${e.message}`); } } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${w}.${k}`); };
  workflow.nodes.forEach((n) => visit(n.parameters, n.name));
  check('Every {{ expression }} parses as JavaScript', exprErr.length === 0, exprErr.join('; '));
  const cErr = [];
  for (const [n, s] of codeSrc) { try { new vm.Script(`(() => {\n${s}\n})`); } catch (e) { cErr.push(`${n}: ${e.message}`); } }
  check('Every Code node compiles', cErr.length === 0, cErr.join('; '));
  check('Code nodes call no require() (no network, fs or crypto modules)', codeSrc.every(([, s]) => !/\brequire\s*\(/.test(s)));

  // -------------------------------------------------------- 2. safe defaults
  section('2. Safe defaults, config validation and period resolution');
  const cfg = (env, trigger = 'manual', webhookItem) => { const r = runWorkflow({ env, trigger, webhookItem, mocks: makeMocks() }); return { r, c: r.last('Config & Safety Gate') && r.last('Config & Safety Gate')[0].config }; };
  const { c: d0 } = cfg({ NOW_OVERRIDE: NOW });
  check('Empty env -> SANDBOX_MODE and DRY_RUN on', d0.sandboxMode && d0.dryRun);
  check('Empty env -> CSV export and HubSpot stamp blocked', !d0.export.allowedByConfig && !d0.hubspot.stampAllowed);
  check('Empty env -> 90-day inclusive linear window anchored on contract start', d0.clawback.windowDays === 90 && d0.clawback.windowInclusive && d0.clawback.policy === 'linear' && d0.clawback.anchor === 'contract_start');
  check('Empty env -> recorded commission only, pending review blocks export', d0.commission.source === 'recorded_only' && d0.guards.blockOnPendingReview);
  check('Default period = previous calendar month (2026-10)', d0.period.id === '2026-10' && d0.period.source === 'default-previous-month');
  const { c: typo } = cfg({ NOW_OVERRIDE: NOW, SANDBOX_MODE: 'flase', DRY_RUN: 'nope', CSV_EXPORT_ENABLED: 'yes please', HUBSPOT_MUTATIONS_ENABLED: 'TRUE ' });
  check('Typos keep SANDBOX/DRY_RUN on and do not arm export', typo.sandboxMode && typo.dryRun && !typo.export.enabled);
  const { c: blk } = cfg('BLOCKED');
  check('Blocked $env -> all safe defaults', blk.envBlocked && blk.sandboxMode && blk.dryRun && !blk.export.allowedByConfig);
  const { c: stampOnly } = cfg({ ...LIVE, DRY_RUN: 'false', HUBSPOT_MUTATIONS_ENABLED: 'true' });
  check('HubSpot stamp is refused unless CSV export is enabled (stamp only after export)', !stampOnly.hubspot.stampAllowed && stampOnly.hubspot.stampBlockers.some((b) => b.includes('successful CSV export')));
  const { c: badCfg } = cfg({ NOW_OVERRIDE: NOW, CLAWBACK_WINDOW_DAYS: '0', CLAWBACK_POLICY: 'tiered', CLAWBACK_TIERS: '30:1,120:0.5,abc', FX_RATES: 'EUR:-1,GBP:1.27', MAX_TOTAL_CLAWBACK: '1e9' });
  check('Invalid window / tiers / FX / guard values become config errors', badCfg.configErrors.length >= 4 && badCfg.export.blockers.some((b) => /configuration error/.test(b)), JSON.stringify(badCfg.configErrors));
  const rp = runWorkflow({ env: { NOW_OVERRIDE: NOW, RECONCILIATION_PERIOD: '2026-13' }, mocks: makeMocks() });
  check('Invalid RECONCILIATION_PERIOD is refused', rp.error && /Invalid reconciliation period/.test(rp.error.message));
  const rf = runWorkflow({ env: { NOW_OVERRIDE: NOW, RECONCILIATION_PERIOD: '2026-12' }, mocks: makeMocks() });
  check('A future period is refused', rf.error && /in the future/.test(rf.error.message));
  const { c: open } = cfg({ NOW_OVERRIDE: NOW, RECONCILIATION_PERIOD: '2026-11' });
  check('A still-open period is allowed with a warning', open.period.open && open.warnings.some((w) => /has not ended/.test(w)));
  const { r: secretRun } = cfg(ARMED);
  check('Config output never contains secret values', Object.values(TOKENS).every((s) => !JSON.stringify(secretRun.runData['Config & Safety Gate']).includes(s)));

  // ----------------------------------------------------- 3. live refusals
  section('3. Live-mode refusals and webhook authentication');
  const r1 = runWorkflow({ env: { SANDBOX_MODE: 'false', HUBSPOT_PORTAL_ID: '99000001' }, mocks: makeMocks() });
  check('Live without HUBSPOT_ACCESS_TOKEN is refused', r1.error && /HUBSPOT_ACCESS_TOKEN/.test(r1.error.message));
  const r2 = runWorkflow({ env: { SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: 'x' }, mocks: makeMocks() });
  check('Live without numeric HUBSPOT_PORTAL_ID is refused', r2.error && /HUBSPOT_PORTAL_ID/.test(r2.error.message));
  const whM = makeMocks();
  const r3 = runWorkflow({ trigger: 'webhook', webhookItem: { headers: {}, query: {}, body: { period: '2026-10' } }, env: LIVE, mocks: whM });
  check('Live webhook without secret is rejected before any API call', r3.error && /Webhook rejected/.test(r3.error.message) && whM.state.calls.length === 0);
  const r4 = runWorkflow({ trigger: 'webhook', webhookItem: { headers: { 'x-reconciliation-secret': 'wrong-wrong-wrong-wrong' }, query: {}, body: {} }, env: LIVE, mocks: makeMocks() });
  check('Live webhook with a wrong secret is rejected', r4.error && /Webhook rejected/.test(r4.error.message));
  const r5 = runWorkflow({ trigger: 'webhook', webhookItem: { headers: { 'X-Reconciliation-Secret': TOKENS.WEBHOOK_SHARED_SECRET }, query: {}, body: { period: '2026-09' } }, env: LIVE, mocks: makeMocks() });
  const c5 = r5.last('Config & Safety Gate')[0].config;
  check('Valid webhook sets the period from the body and strips the secret', !r5.error && c5.period.id === '2026-09' && c5.period.source === 'webhook' && !JSON.stringify(r5.runData['Config & Safety Gate']).includes(TOKENS.WEBHOOK_SHARED_SECRET));
  const r6 = runWorkflow({ trigger: 'schedule', env: { NOW_OVERRIDE: NOW }, mocks: makeMocks() });
  check('Monthly schedule trigger runs the previous month in sandbox', !r6.error && r6.last('Reconciliation Report')[0].period === '2026-10');

  // ---------------------------------------------------- 4. fixture parity
  section('4. Fixture parity and synthetic-data hygiene');
  const emb = byName['Load Synthetic Churn Fixture'].parameters.jsCode.match(/const FIXTURE = ([\s\S]*?);\n\nreturn/);
  let parity = false;
  try { parity = JSON.stringify(JSON.parse(emb[1])) === JSON.stringify(fixture); } catch (e) { parity = false; }
  check('Fixture embedded in workflow.json equals sample-payloads/closed-lost-churn-fixture.json', parity);
  check('Fixture flagged synthetic, portal 99000001, 16 scenarios', fixture._meta.synthetic && fixture.portalId === '99000001' && fixture.deals.length === 16);
  check('Payroll references in the fixture are synthetic EMP-SYN-* placeholders', Object.values(fixture.sandboxRepPayrollRefs).every((v) => /^EMP-SYN-\d{4}$/.test(v)));

  // ------------------------------------------------- 5. money & dates unit
  section('5. Exact money, rounding and date parsing');
  const calcSrc = byName['Clawback Calculator'].parameters.jsCode;
  const grab = (src, name) => { const s = src.indexOf(`function ${name}(`); let depth = 0; for (let i = src.indexOf('{', s); i < src.length; i++) { if (src[i] === '{') depth++; if (src[i] === '}' && --depth === 0) return src.slice(s, i + 1); } return ''; };
  const ux = {};
  vm.runInNewContext(`const pow10 = (n) => 10n ** BigInt(n); const roundDiv = (num, den) => (num * 2n + den) / (den * 2n); const DAY = 86400000;\n${grab(calcSrc, 'parseMoney')}\n${grab(calcSrc, 'fmt')}\n${grab(calcSrc, 'parseDay')}\n${grab(calcSrc, 'utf8Bytes')}\n${grab(calcSrc, 'sha256')}\nthis.parseMoney = parseMoney; this.fmt = fmt; this.parseDay = parseDay; this.sha256 = sha256;`, ux);
  const pm = (s, dp = 2) => { const r = ux.parseMoney(s, dp); return r.ok ? r.minor.toString() : r.empty ? 'EMPTY' : 'INVALID'; };
  const moneyCases = [['1,234.56', '123456'], ['1234.56', '123456'], ['9500', '950000'], ['0.005', '1'], ['0.004', '0'], ['2.675', '268'], ['9.500,00', 'INVALID'], ['9,5OO', 'INVALID'], ['12k', 'INVALID'], ['-5', 'INVALID'], ['1,23', 'INVALID'], ['', 'EMPTY'], [null, 'EMPTY']];
  for (const [s, want] of moneyCases) check(`parseMoney(${JSON.stringify(s)}) -> ${want}`, pm(s) === want, pm(s));
  check('Zero-decimal currency: parseMoney("300000", 0) -> 300000, "1.5" -> 2 (half-up)', pm('300000', 0) === '300000' && pm('1.5', 0) === '2');
  check('fmt renders signed minor units (-728333 -> "-7283.33", JPY 0dp)', ux.fmt(728333n, 2, true) === '-7283.33' && ux.fmt(5n, 2) === '0.05' && ux.fmt(300000n, 0) === '300000' && ux.fmt(0n, 2, true) === '0.00');
  const pd = (s) => { const r = ux.parseDay(s); return r.ok ? r.iso : r.empty ? 'EMPTY' : 'INVALID'; };
  const dateCases = [['2026-10-01', '2026-10-01'], ['2026-08-20T15:30:00.000Z', '2026-08-20'], ['1788393600000', '2026-09-03'], ['2026-02-30', 'INVALID'], ['10/01/2026', 'INVALID'], ['1899-01-01', 'INVALID'], ['', 'EMPTY']];
  for (const [s, want] of dateCases) check(`parseDay(${JSON.stringify(s)}) -> ${want}`, pd(s) === want, pd(s));
  const KAT = [['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'], ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'], ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1']];
  check('Embedded pure-JS SHA-256 passes NIST known-answer vectors', KAT.every(([m, h]) => ux.sha256(m) === h));

  // -------------------------------------------------- 6. sandbox end-to-end
  section('6. Sandbox end-to-end: every 90-day scenario');
  const sb = SB();
  check('Sandbox run completes', !sb.error, sb.error && sb.error.message);
  check('Sandbox run makes ZERO HTTP calls and writes ZERO files', sb.mocks.state.calls.length === 0 && Object.keys(sb.mocks.state.files).length === 0);
  const c = calcOf(sb);
  const expected = { 990010001: 'CLAWBACK', 990010002: 'CLAWBACK', 990010003: 'CLAWBACK', 990010004: 'NO_CLAWBACK_DUE', 990010005: 'OUTSIDE_WINDOW', 990010006: 'CLAWBACK', 990010007: 'CLAWBACK', 990010008: 'PENDING_REVIEW', 990010009: 'CLAWBACK', 990010010: 'EXEMPT', 990010011: 'SKIP_ALREADY_RECONCILED', 990010012: 'PENDING_REVIEW', 990010013: 'PENDING_REVIEW', 990010014: 'PENDING_REVIEW', 990010015: 'CLAWBACK', 990010016: 'PENDING_REVIEW' };
  const got = Object.fromEntries(c.deals.map((d) => [d.dealId, d.status]));
  check('Deal statuses match all 16 fixture expectations', JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
  const reasons = Object.fromEntries(c.deals.map((d) => [d.dealId, d.reasonCode]));
  check('Reason codes: FX missing, bad commission, churn before anchor, missing owner, missing SDR commission', reasons['990010008'] === 'FX_RATE_MISSING' && reasons['990010012'] === 'INVALID_COMMISSION_AMOUNT' && reasons['990010013'] === 'CHURN_BEFORE_ANCHOR' && reasons['990010014'] === 'MISSING_AE_OWNER' && reasons['990010016'] === 'MISSING_RECORDED_COMMISSION');
  const refCases = [['990010001', 'AE', 21], ['990010001', 'SDR', 21], ['990010002', 'AE', 60], ['990010003', 'AE', 89], ['990010003', 'SDR', 89], ['990010006', 'AE', 45], ['990010006', 'SDR', 45], ['990010007', 'AE', 10], ['990010009', 'AE', 46], ['990010009', 'SDR', 46], ['990010015', 'SDR', 50]];
  for (const [id, role, days] of refCases) {
    const row = rowOf(c, id, role);
    const ref = reference(id, role);
    check(`${id} ${role}: day ${days}, ${row && row.clawbackAmount} matches reference ${ref.amount.toFixed(2)}`, row && row.daysActive === days && ref.days === days && row.clawbackAmount === ref.amount.toFixed(2), row && JSON.stringify({ d: row.daysActive, a: row.clawbackAmount }));
  }
  check('Day 89 is in window, day 90 inclusive with linear rate 0 -> BELOW_DE_MINIMIS, day 141 outside', rowOf(c, '990010003', 'AE').clawbackRate === '0.011111' && rowOf(c, '990010004', 'AE').status === 'BELOW_DE_MINIMIS' && dealOf(c, '990010005').status === 'OUTSIDE_WINDOW');
  check('Displayed clawback_rate is rounded half-up (69/90 -> 0.766667)', rowOf(c, '990010001', 'AE').clawbackRate === '0.766667');
  check('Closed-lost churn detected from stage entry dates, anchored on closed-won entry', rowOf(c, '990010009', 'AE').churnSource === 'closed_lost_stage' && rowOf(c, '990010009', 'AE').anchorSource === 'closed_won_entered');
  check('Epoch-ms contract start parsed; zero AE commission -> NO_COMMISSION_PAID', rowOf(c, '990010015', 'SDR').anchorDate === '2026-09-03' && rowOf(c, '990010015', 'AE').status === 'NO_COMMISSION_PAID');
  check('EUR and JPY converted with synthetic FX (JPY zero-decimal)', rowOf(c, '990010006', 'AE').commissionPayroll === '7776.00' && rowOf(c, '990010007', 'AE').originalCommission === '300000' && rowOf(c, '990010007', 'AE').commissionPayroll === '2010.00');
  check('Valid AE row of a deal under review is HELD, not paid', rowOf(c, '990010016', 'AE').status === 'HELD_DEAL_PENDING_REVIEW' && rowOf(c, '990010016', 'SDR').status === 'PENDING_REVIEW');
  const claws = c.rows.filter((r) => r.status === 'CLAWBACK');
  const sumCents = claws.reduce((s, r) => s + r.clawbackMinor, 0);
  check(`Grand total equals the sum of ${claws.length} adjustments (${c.totals.total})`, c.totals.totalMinor === sumCents && c.totals.total === `-${(sumCents / 100).toFixed(2)}` && claws.length === 11);
  check('Per-rep totals add up to the grand total', c.totals.byRep.reduce((s, t) => s + Math.round(Number(t.total) * 100), 0) === -sumCents);
  check('Adjustment IDs are unique and deterministic', new Set(c.rows.map((r) => r.adjustmentId)).size === c.rows.length && SB().last('Clawback Calculator')[0].rows.map((r) => r.adjustmentId).join() === c.rows.map((r) => r.adjustmentId).join());
  check('Reconciliation ID is deterministic for identical input', SB().last('Clawback Calculator')[0].reconciliationId === c.reconciliationId && /^REC-2026-10-[0-9A-F]{10}$/.test(c.reconciliationId));
  check('Guard: pending-review deals block the export by default', !c.guards.passed && c.guards.failures.some((f) => /need review/.test(f)));
  const rep = sb.last('Reconciliation Report')[0];
  check('Report: DRY_RUN with export and stamp blockers listed', rep.status === 'DRY_RUN' && rep.exportBlockedBy.some((b) => b.startsWith('SANDBOX_MODE')) && rep.stampBlockedBy.length > 0);

  // ------------------------------------------------------------ 7. CSV
  section('7. CSV correctness, integrity and draft naming');
  const pay = fileOf(sb, 'payroll');
  const aud = fileOf(sb, 'audit');
  const man = fileOf(sb, 'manifest');
  check('Three files built: payroll CSV, audit CSV, manifest JSON (as n8n binaries)', pay && aud && man && sb.lastItems('CSV Builder & Integrity').every((i) => i.binary && i.binary.data && i.binary.data.data));
  check('Blocked export -> every file is named DRAFT-...', [pay, aud, man].every((f) => f.fileName.startsWith('DRAFT-clawback-2026-10-')));
  const lines = pay.content.split('\r\n').filter(Boolean);
  check('Payroll CSV: header + one line per CLAWBACK adjustment, CRLF line endings', lines.length === claws.length + 1 && !/[^\r]\n/.test(pay.content));
  check('Payroll CSV holds no HELD / PENDING / zero rows', !/HELD_DEAL|PENDING_REVIEW|BELOW_DE_MINIMIS/.test(pay.content) && !pay.content.includes('990010016'));
  check('Negative amounts stay numeric (no formula-guard apostrophe)', pay.content.includes(',-7283.33,') && !pay.content.includes("'-7283.33"));
  check('Audit CSV covers every deal (16) and every role row', aud.content.split('\r\n').filter(Boolean).length - 1 === c.rows.length + c.deals.filter((d) => !c.rows.some((r) => r.dealId === d.dealId)).length);
  const b64 = (i) => Buffer.from(sb.lastItems('CSV Builder & Integrity')[i].binary.data.data, 'base64').toString('utf8');
  check('Binary payloads decode to exactly the checksummed content', b64(0) === pay.content && ux.sha256(b64(0)) === pay.sha256 && ux.sha256(b64(1)) === aud.sha256);
  const manifest = JSON.parse(man.content);
  check('Manifest lists file checksums, totals and the blocked state', manifest.files.find((f) => f.kind === 'payroll').sha256 === pay.sha256 && manifest.totals.total === c.totals.total && manifest.exportAllowed === false);
  const named = SB({ CSV_INCLUDE_DEAL_NAME: 'true' });
  const np = fileOf(named, 'payroll').content;
  check('Formula-injection guard: "=HYPERLINK(...)" deal name exported as quoted text with leading apostrophe', np.includes(`"'=HYPERLINK(""https://example.com"",""Northstar Renewal (Mock)"")"`), np.split('\r\n')[2]);
  check('Deal names are excluded from the payroll CSV by default', !pay.content.includes('Acme Enterprise'));
  fs.writeFileSync(path.join(OUT_DIR, pay.fileName), pay.content);
  fs.writeFileSync(path.join(OUT_DIR, aud.fileName), aud.content);
  fs.writeFileSync(path.join(OUT_DIR, man.fileName), man.content);
  fs.writeFileSync(path.join(OUT_DIR, 'sandbox-report.json'), JSON.stringify(rep, null, 2) + '\n');

  // ---------------------------------------------------------- 8. policies
  section('8. Policies, anchors, retention, computed commission and guards');
  const tier = calcOf(SB({ CLAWBACK_POLICY: 'tiered' }));
  check('Tiered 30:1,60:0.5,90:0.25 -> day 21 100%, day 60 50%, day 89 25%', rowOf(tier, '990010001', 'AE').clawbackAmount === '-9500.00' && rowOf(tier, '990010002', 'AE').clawbackAmount === '-3000.00' && rowOf(tier, '990010003', 'AE').clawbackAmount === '-1125.00');
  check('Tiered: day 90 (inclusive) is clawed back at 25%', rowOf(tier, '990010004', 'AE').clawbackAmount === '-750.00' && rowOf(tier, '990010004', 'AE').status === 'CLAWBACK');
  const full = calcOf(SB({ CLAWBACK_POLICY: 'full' }));
  check('Full policy: any churn inside the window claws back 100%', rowOf(full, '990010003', 'AE').clawbackAmount === '-4500.00');
  const excl = calcOf(SB({ CLAWBACK_POLICY: 'full', CLAWBACK_WINDOW_INCLUSIVE: 'false' }));
  check('Exclusive window: day 90 -> OUTSIDE_WINDOW', dealOf(excl, '990010004').status === 'OUTSIDE_WINDOW' && rowOf(excl, '990010003', 'AE').status === 'CLAWBACK');
  const anc = calcOf(SB({ CLAWBACK_WINDOW_ANCHOR: 'close_date' }));
  check('Anchor = close_date uses closed-won entry / close date (day 26 for deal 990010001)', rowOf(anc, '990010001', 'AE').daysActive === 26 && rowOf(anc, '990010001', 'AE').anchorSource === 'closed_won_entered');
  const ret = calcOf(SB({ CLAWBACK_RETAIN_COLLECTED_CASH: 'true' }));
  const refRet = reference('990010001', 'AE', { collected: 0.75 });
  check('Collected-cash retention: 25% paid -> clawback x 0.75 (matches reference)', rowOf(ret, '990010001', 'AE').collectedRatio === '0.2500' && rowOf(ret, '990010001', 'AE').clawbackAmount === refRet.amount.toFixed(2), rowOf(ret, '990010001', 'AE').clawbackAmount);
  check('Retention ignores voided invoices (EUR deal: 18,000 of 72,000 paid)', rowOf(ret, '990010006', 'AE').collectedRatio === '0.2500');
  const comp = calcOf(SB({ COMMISSION_SOURCE: 'recorded_then_computed' }));
  check('Computed commission fills a missing SDR amount (40,000 x 0.02 = 800.00) and is flagged', rowOf(comp, '990010016', 'SDR').originalCommission === '800.00' && rowOf(comp, '990010016', 'SDR').commissionSource === 'computed@0.02' && dealOf(comp, '990010016').status === 'CLAWBACK');
  check('Computed mode still refuses a malformed deal amount', rowOf(comp, '990010012', 'AE').reasonCode === 'INVALID_COMMISSION_AMOUNT');
  const minAmt = calcOf(SB({ CLAWBACK_MIN_AMOUNT: '100' }));
  check('CLAWBACK_MIN_AMOUNT=100 turns 50.00 / 10.00 adjustments into BELOW_DE_MINIMIS', rowOf(minAmt, '990010003', 'AE').status === 'BELOW_DE_MINIMIS' && rowOf(minAmt, '990010003', 'SDR').status === 'BELOW_DE_MINIMIS');
  const gTot = calcOf(SB({ MAX_TOTAL_CLAWBACK: '1000', BLOCK_EXPORT_ON_PENDING_REVIEW: 'false' }));
  check('MAX_TOTAL_CLAWBACK guard blocks an unexpectedly large run', gTot.guards.failures.some((f) => /MAX_TOTAL_CLAWBACK/.test(f)));
  const gOne = calcOf(SB({ MAX_SINGLE_ADJUSTMENT: '5000', BLOCK_EXPORT_ON_PENDING_REVIEW: 'false' }));
  check('MAX_SINGLE_ADJUSTMENT guard names the offending adjustment', gOne.guards.failures.some((f) => f.includes(rowOf(gOne, '990010001', 'AE').adjustmentId)));
  const reqRef = calcOf(SB({ REQUIRE_PAYROLL_REF: 'true' }));
  check('REQUIRE_PAYROLL_REF=true sends unmapped reps to PENDING_REVIEW', rowOf(reqRef, '990010002', 'AE').reasonCode === 'MISSING_PAYROLL_REF');
  const gbp = calcOf(SB({ PAYROLL_CURRENCY: 'EUR', FX_RATES: 'USD:0.92', FX_RATES_AS_OF: '2026-10-31' }));
  check('Payroll currency EUR: USD deals convert, EUR deal needs no FX, JPY without a rate -> review', rowOf(gbp, '990010006', 'AE').fxRate === '1' && rowOf(gbp, '990010001', 'AE').fxRate === '0.92' && rowOf(gbp, '990010007', 'AE').reasonCode === 'FX_RATE_MISSING');

  // --------------------------------------------- 9. live paths (mocked)
  section('9. Live HubSpot paths with mocks: search, pagination, invoices, fail-closed');
  const lm = makeMocks();
  const lv = runWorkflow({ env: LIVE, mocks: lm });
  check('Live dry-run completes', !lv.error, lv.error && lv.error.message);
  const sCall = lm.state.calls.find((x) => x.path === '/crm/v3/objects/deals/search');
  const g = sCall.body.filterGroups;
  check('Search body: churn_date in [2026-10-01, 2026-11-01) as epoch ms', g[0].filters[0].value === String(Date.UTC(2026, 9, 1)) && g[0].filters[1].value === String(Date.UTC(2026, 10, 1)) && g[0].filters[0].operator === 'GTE' && g[0].filters[1].operator === 'LT');
  check('Search body: closed-lost group requires closed-won history; 200 per page; stable sort', g[1].filters.some((f) => f.operator === 'HAS_PROPERTY' && f.propertyName === 'hs_date_entered_closedwon') && sCall.body.limit === 200 && sCall.body.sorts[0].propertyName === 'hs_object_id');
  check('Live calls are read-only (search, v4 association read, invoice batch read)', lm.state.calls.every((x) => /\/search$|\/batch\/read$/.test(x.path)));
  const lc = calcOf(lv);
  check('Live search returns the same 16 deals and identical results to the sandbox', lc.deals.length === 16 && lc.totals.total === c.totals.total && lc.reconciliationId === c.reconciliationId);
  check('Live invoices are collected via associations', lv.last('Normalize Deal Records')[0].records.find((x) => x.deal.id === '990010001').invoices.length === 2);
  const many = [...fixture.deals];
  for (let i = 0; i < 434; i++) many.push({ id: String(991000000 + i), properties: { dealname: `Synthetic Bulk ${i} (Mock)`, amount: '10000', deal_currency_code: 'USD', dealstage: 'closedwon', contract_start_date: '2026-09-15', churn_date: '2026-10-20', hubspot_owner_id: '99100001', ae_commission_paid: '1000' } });
  const pgM = makeMocks({ deals: many });
  const pgR = runWorkflow({ env: { ...LIVE, INVOICE_COLLECTION_ENABLED: 'false' }, mocks: pgM });
  check('Pagination: 450 deals collected across 3 pages of 200', !pgR.error && pgM.state.calls.filter((x) => x.path.endsWith('/search')).length === 3 && calcOf(pgR).deals.length === 450, pgR.error && pgR.error.message);
  check('Pagination: no duplicates, no gaps', new Set(calcOf(pgR).deals.map((d) => d.dealId)).size === 450);
  const capR = runWorkflow({ env: LIVE, mocks: makeMocks({ fakeTotal: 12000 }) });
  check('Fail closed: > 10,000 search matches aborts the run (no CSV built)', capR.error && /10,000/.test(capR.error.message) && !capR.last('CSV Builder & Integrity'));
  const endR = runWorkflow({ env: LIVE, mocks: makeMocks({ endlessPaging: true }) });
  check('Fail closed: pagination truncated at 50 pages aborts the run', endR.error && /pagination stopped/i.test(endR.error.message));
  const failR = runWorkflow({ env: LIVE, mocks: makeMocks({ failSearch: true }) });
  check('Fail closed: a search error aborts the run (no partial reconciliation)', failR.error && /search/i.test(failR.error.message) && !failR.last('Clawback Calculator'));
  const invF = runWorkflow({ env: { ...LIVE, CLAWBACK_RETAIN_COLLECTED_CASH: 'true' }, mocks: makeMocks({ failInvoices: true }) });
  check('Invoice scope missing + retention on -> affected rows go to PENDING_REVIEW (never guessed)', !invF.error && rowOf(calcOf(invF), '990010002', 'AE').reasonCode === 'INVOICE_DATA_UNAVAILABLE');
  const invOff = runWorkflow({ env: { ...LIVE, INVOICE_COLLECTION_ENABLED: 'false' }, mocks: makeMocks() });
  check('INVOICE_COLLECTION_ENABLED=false skips invoice calls entirely', !invOff.error && invOff.mocks.state.calls.every((x) => x.path.endsWith('/search')));
  const sep = runWorkflow({ env: { ...LIVE, RECONCILIATION_PERIOD: '2026-09' }, mocks: makeMocks() });
  check('Period filter: no fixture deal churned in 2026-09 -> zero adjustments, empty payroll file', !sep.error && calcOf(sep).totals.adjustments === 0 && fileOf(sep, 'payroll').content.split('\r\n').filter(Boolean).length === 1);
  const fxGuard = runWorkflow({ env: { ...LIVE, FX_RATES_AS_OF: '', BLOCK_EXPORT_ON_PENDING_REVIEW: 'false' }, mocks: makeMocks() });
  check('FX used without FX_RATES_AS_OF blocks the export', calcOf(fxGuard).guards.failures.some((f) => /FX_RATES_AS_OF/.test(f)));

  // ---------------------------------------- 10. export, stamp, idempotency
  section('10. Armed export + stamp ordering and idempotency (mocked)');
  const am = makeMocks({ deals: cleanDeals });
  const ar = runWorkflow({ env: ARMED, mocks: am });
  check('Armed run on clean data completes', !ar.error, ar.error && ar.error.message);
  const files = Object.keys(am.state.files);
  check('Exactly 3 files written to CSV_EXPORT_DIR, no DRAFT prefix', files.length === 3 && files.every((p) => p.startsWith('/data/exports/clawback-2026-10-REC-2026-10-')), files.join(', '));
  const writtenManifest = JSON.parse(am.state.files[files.find((p) => p.endsWith('manifest.json'))]);
  check('Written files match the manifest checksums byte-for-byte', writtenManifest.files.every((f) => ux.sha256(am.state.files[`/data/exports/${f.fileName}`]) === f.sha256) && writtenManifest.exportAllowed === true);
  const upd = am.state.calls.filter((x) => x.path.endsWith('/batch/update'));
  const lastSearchIdx = am.state.calls.map((x) => x.path).lastIndexOf('/crm/v3/objects/deals/search');
  check('One batch update, issued after the search (files are written before it in the flow)', upd.length === 1 && am.state.calls.indexOf(upd[0]) > lastSearchIdx);
  const stampedIds = upd[0].body.inputs.map((i) => i.id).sort();
  check('Stamped: CLAWBACK / NO_CLAWBACK_DUE / OUTSIDE_WINDOW / EXEMPT deals only (never already-reconciled)', JSON.stringify(stampedIds) === JSON.stringify(['990010001', '990010002', '990010003', '990010004', '990010005', '990010006', '990010007', '990010009', '990010010', '990010015']), stampedIds.join(','));
  const s1 = upd[0].body.inputs.find((i) => i.id === '990010001').properties;
  check('Stamp properties: status, AE/SDR magnitudes, reconciliation ID, processed-at', s1.clawback_status === 'CLAWBACK' && s1.clawback_ae_amount === '7283.33' && s1.clawback_sdr_amount === '1456.67' && /^REC-2026-10-/.test(s1.clawback_reconciliation_id) && s1.clawback_processed_at === NOW);
  check('Report: EXPORTED_AND_STAMPED', ar.last('Reconciliation Report')[0].status === 'EXPORTED_AND_STAMPED');
  const again = runWorkflow({ env: ARMED, mocks: am });
  const ca = calcOf(again);
  check('Re-run of the same period: every stamped deal is SKIP_ALREADY_RECONCILED, zero new adjustments', !again.error && ca.totals.adjustments === 0 && ca.deals.filter((d) => d.status === 'SKIP_ALREADY_RECONCILED').length === 11);
  const wf = makeMocks({ deals: cleanDeals, failWrite: true });
  const wr = runWorkflow({ env: ARMED, mocks: wf });
  check('Failed file write stops the run and NO deal is stamped', wr.error && /EACCES/.test(wr.error.message) && !wf.state.calls.some((x) => x.path.endsWith('/batch/update')));
  const sf = runWorkflow({ env: ARMED, mocks: makeMocks({ deals: cleanDeals, failStamp: true }) });
  check('Stamp errors are reported as EXPORTED_STAMP_PARTIAL', sf.last('Reconciliation Report')[0].status === 'EXPORTED_STAMP_PARTIAL' && sf.last('Reconciliation Report')[0].stamp.failed === 10);
  const noMut = makeMocks({ deals: cleanDeals });
  const nm = runWorkflow({ env: { ...ARMED, HUBSPOT_MUTATIONS_ENABLED: 'false' }, mocks: noMut });
  check('Export without mutations: files written, zero CRM writes, report EXPORTED', Object.keys(noMut.state.files).length === 3 && !noMut.state.calls.some((x) => x.path.endsWith('/batch/update')) && nm.last('Reconciliation Report')[0].status === 'EXPORTED');
  const dirty = makeMocks();
  const dr = runWorkflow({ env: ARMED, mocks: dirty });
  check('Armed but pending-review deals present -> export blocked, DRAFT only, no stamp', dr.last('Reconciliation Report')[0].status === 'DRY_RUN' && Object.keys(dirty.state.files).length === 0 && !dirty.state.calls.some((x) => x.path.endsWith('/batch/update')));
  const allOut = JSON.stringify([ar.runData['Reconciliation Report'], am.state.files, sb.runData['CSV Builder & Integrity']]);
  check('No secret value appears in any file, report or CSV', Object.values(TOKENS).every((t) => !allOut.includes(t)));
  fs.writeFileSync(path.join(OUT_DIR, 'armed-run-report.json'), JSON.stringify(ar.last('Reconciliation Report')[0], null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'armed-run-call-log.json'), JSON.stringify(am.state.calls.map((x) => ({ node: x.node, method: x.method, path: x.path })), null, 2) + '\n');

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  console.log(`Sandbox total clawback: ${c.totals.total} ${c.payrollCurrency} across ${c.totals.adjustments} adjustments (${c.reconciliationId})`);
  console.log('Output written to: sim-output/ (git-ignored)');
  if (failed) { console.log('\nFailures:\n' + failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
})();
