// tests/approval/self-approval.test.js — Plan 5c shared module (pure parts always; DB parts need TEST_DATABASE_URL + Redis db 15)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Redis from 'ioredis';
import {
  SELF_MSG, stepsText, promptText, selfNote, doneText, selfEmailHtml, planOwnSteps, planOwnOpen, planOwnLeft, sameOwnSteps,
  requestConsent, consentFor, recordAuto, withoutStamps, autoAdvance, askBody, planChangedBody,
} from '../../api/lib/approval/self-approval.js';
import { confirmPassword, failKey, lockKey, STEP_UP_MSG } from '../../api/lib/approval/step-up.js';
import { NO_SAMPLE } from '../../api/lib/approval/signature-check.js';
import { applyApproval } from '../../api/lib/approval/engine.js';
import { PW, FAKE_STAMP, useStepUp } from './step-up-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const db = url ? new pg.Pool({ connectionString: url }) : null;
const redis = url ? new Redis(process.env.REDIS_URL || 'redis://localhost:6379/15') : null;
const ME = 'sa-me@test.vn';
const NOSIG = 'sa-nosig@test.vn';
const AT = '2026-10-08T02:00:00.000Z';
const entry = (email, label = '', role = null) => ({ type: role ? 'role' : 'person', role, label, email, name: email, status: 'pending', at: null, signature: '' });
const PLAN = {
  flowId: null, version: 0, workflow: 'voucher', companyId: null, status: 'pending', rejectedBy: null,
  steps: [
    { name: 'Kiểm tra', status: 'pending', approvers: [entry(ME)] },
    { name: 'Phê duyệt', status: 'pending', approvers: [entry('other@test.vn', 'Kế toán trưởng', 'chief_accountant')] },
    { name: 'Nhóm cuối', status: 'pending', approvers: [entry(ME), entry('other2@test.vn')] },
  ],
};
let cleanup;
before(async () => {
  if (!db) return;
  cleanup = await useStepUp(db, redis, [ME, NOSIG]);
  await db.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', 'https://drive/sa-me') WHERE LOWER(email) = $1`, [ME]);
  await db.query(`UPDATE employees SET extra = extra - 'Signature' WHERE LOWER(email) = $1`, [NOSIG]);
});
after(async () => {
  if (!db) return;
  await redis.del(failKey(ME), lockKey(ME));
  await cleanup();
  await db.end();
  await redis.quit();
});

test('texts: steps, prompt, note, done, email line (escaped)', () => {
  const one = [{ step: 1, labels: ['Kế toán trưởng'] }];
  const two = [{ step: 1, labels: ['Kế toán trưởng'] }, { step: 3, labels: ['Thủ quỹ'] }];
  assert.equal(stepsText(one), '1 (Kế toán trưởng)');
  assert.equal(stepsText(two), '1 (Kế toán trưởng) và 3 (Thủ quỹ)');
  assert.equal(stepsText([...two, { step: 5, labels: ['Người mua hàng'] }]), '1 (Kế toán trưởng), 3 (Thủ quỹ) và 5 (Người mua hàng)');
  assert.equal(stepsText(two, 'en'), '1 (Kế toán trưởng) and 3 (Thủ quỹ)');
  assert.equal(promptText(one, 'vi'), 'Bạn cũng là người duyệt bước 1 (Kế toán trưởng) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.');
  assert.equal(promptText(one, 'en'), 'You are also the approver of step 1 (Kế toán trưởng) of this request. Enter your password to approve your steps automatically.');
  assert.equal(selfNote(['Người duyệt Ngân sách', 'Người duyệt NCC']), 'Tự động duyệt khi gửi phiếu (người đề nghị là Người duyệt Ngân sách, Người duyệt NCC)');
  assert.equal(doneText(two), 'Đã tự động duyệt bước 1 (Kế toán trưởng) và 3 (Thủ quỹ) của bạn.');
  assert.equal(selfEmailHtml([]), '');
  assert.equal(selfEmailHtml([{ step: 2, labels: ['<b>X</b>'] }]),
    '<p>Các bước bạn là người duyệt đã được tự động duyệt khi gửi phiếu (đã xác nhận bằng mật khẩu): bước 2 (&lt;b&gt;X&lt;/b&gt;).</p>');
});

test('engine plans: own steps in order (label, else the step name), open entries only, group steps only mine', () => {
  assert.deepEqual(planOwnSteps(PLAN, ' SA-ME@test.vn').map(({ step, key, labels, entries }) => ({ step, key, labels, entries })), [
    { step: 1, key: 'person', labels: ['Kiểm tra'], entries: [{ role: null, label: '' }] },
    { step: 3, key: 'person', labels: ['Nhóm cuối'], entries: [{ role: null, label: '' }] },
  ]);
  assert.deepEqual(planOwnSteps(PLAN, 'other@test.vn').map((o) => [o.step, o.key, o.labels]), [[2, 'chief_accountant', ['Kế toán trưởng']]]);
  assert.deepEqual(planOwnSteps(PLAN, ''), []);
  assert.equal(planOwnOpen(PLAN, ME).step, 1);
  assert.equal(planOwnOpen(PLAN, 'other@test.vn'), null, 'step 2 is not open yet');
  const after1 = applyApproval(PLAN, ME, { at: AT }).plan;
  assert.equal(planOwnOpen(after1, ME), null, 'never ahead: step 2 belongs to another approver');
  const after2 = applyApproval(after1, 'other@test.vn', { at: AT }).plan;
  assert.deepEqual(planOwnOpen(after2, ME).entries, [{ role: null, label: '' }], 'group step: my entry only');
  assert.equal(planOwnLeft(after2, ME), true);
  assert.equal(planOwnLeft(applyApproval(after2, ME, { at: AT }).plan, ME), false);
  const pub = planOwnSteps(PLAN, ME).map(({ step, key, labels }) => ({ step, key, labels }));
  assert.equal(sameOwnSteps(planOwnSteps(PLAN, ME), pub), true);
  assert.equal(sameOwnSteps(planOwnSteps(PLAN, ME), pub.slice(1)), false);
});

test('consentFor / recordAuto / withoutStamps / askBody / planChangedBody', () => {
  const c = { by: 'me@x.vn', ref: 'TL-1', consentedAt: AT, method: 'password', round: 0, steps: [],
    stamps: [{ key: 'person', companyId: null, url: 'u', from: 'Master Employee', signature: 'data:image/png;base64,AA' }], auto: [] };
  const q = { submitterEmail: 'me@x.vn', round: 0, ref: 'TL-1' };
  assert.equal(consentFor({ selfApproval: c }, { ...q, submitterEmail: 'ME@x.vn' }), c);
  assert.equal(consentFor({}, q), null, 'old requests: no consent');
  assert.equal(consentFor(null, q), null);
  assert.equal(consentFor({ selfApproval: c }, { ...q, submitterEmail: 'other@x.vn' }), null);
  assert.equal(consentFor({ selfApproval: c }, { ...q, submitterEmail: '' }), null);
  assert.equal(consentFor({ selfApproval: c }, { ...q, round: 1 }), null, 'sent back since: consent void');
  assert.equal(consentFor({ selfApproval: c }, { submitterEmail: 'me@x.vn', ref: 'TL-1' }), null, 'round is required');
  assert.equal(consentFor({ selfApproval: c }, { ...q, round: null }), null, 'round is required');
  assert.equal(consentFor({ selfApproval: c }, { ...q, ref: 'TL-2' }), null, 'consent of another request');
  assert.equal(consentFor({ selfApproval: c }, { ...q, ref: undefined }), null, 'ref is required');
  assert.equal(consentFor({ selfApproval: { ...c, ref: null } }, q), null, 'a consent without ref never applies');
  assert.equal(consentFor({ selfApproval: c }), null);
  assert.equal(consentFor({ selfApproval: { ...c, stamps: [] } }, q), null);
  const mine = { step: 1, key: 'person', labels: ['Kiểm tra'] };
  assert.deepEqual(recordAuto(c, mine, AT, true).auto, [{ step: 1, labels: ['Kiểm tra'], at: AT }]);
  assert.equal(recordAuto(c, mine, AT, true).stamps, c.stamps);
  assert.deepEqual(recordAuto(c, mine, AT, false).stamps, [], 'nothing can come back: the stamp copy is dropped');
  assert.deepEqual(recordAuto(c, mine, AT).stamps, [], 'keepStamp defaults to false');
  const meta = { a: 1, selfApproval: c };
  assert.equal(planOwnLeft(null, 'me@x.vn'), false);
  assert.deepEqual(withoutStamps(meta).selfApproval.stamps, [{ key: 'person', companyId: null, url: 'u', from: 'Master Employee' }]);
  assert.equal(meta.selfApproval.stamps[0].signature.startsWith('data:'), true, 'input not mutated');
  assert.deepEqual(withoutStamps({ a: 1 }), { a: 1 });
  assert.deepEqual(askBody({ ask: { steps: [], prompt: 'P' }, message: 'M' }),
    { success: false, needSelfApproval: true, message: 'M', selfApproval: { steps: [], prompt: 'P' } });
  const changed = planChangedBody(planOwnSteps(PLAN, ME), 'vi');
  assert.equal(changed.message, SELF_MSG.vi.planChanged);
  assert.equal(changed.selfApproval.steps.length, 2);
});

test('requestConsent: nothing to ask, ask, declined, wrong password, no sample, consent with one stamp per sample', { skip }, async () => {
  const own = planOwnSteps(PLAN, ME);
  const base = { db, redis, email: ME, own, companyId: null, ref: 'TL-1', lang: 'vi', at: AT };
  assert.deepEqual(await requestConsent({ ...base, own: [] }), { consent: null });
  assert.deepEqual(await requestConsent({ ...base, email: '' }), { consent: null });
  const ask = await requestConsent(base);
  assert.deepEqual(ask.ask.steps, [{ step: 1, key: 'person', labels: ['Kiểm tra'] }, { step: 3, key: 'person', labels: ['Nhóm cuối'] }]);
  assert.equal(ask.message, 'Bạn cũng là người duyệt bước 1 (Kiểm tra) và 3 (Nhóm cuối) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.');
  assert.equal(ask.ask.prompt, ask.message);
  assert.deepEqual(await requestConsent({ ...base, declined: true }), { consent: null, declined: true });
  assert.equal((await requestConsent({ ...base, password: 'wrong' })).message, STEP_UP_MSG.vi.wrongPassword);
  await redis.del(failKey(ME));
  const ok = await requestConsent({ ...base, password: PW, declined: true });
  assert.deepEqual(Object.keys(ok), ['consent'], 'a password wins over declined');
  assert.deepEqual(ok.consent, {
    by: ME, ref: 'TL-1', consentedAt: AT, method: 'password', round: 0, steps: ask.ask.steps, auto: [],
    stamps: [{ key: 'person', companyId: null, url: 'https://drive/sa-me', from: 'Master Employee', signature: FAKE_STAMP('https://drive/sa-me') }],
  });
  const noSigPlan = { ...PLAN, steps: [{ name: 'X', status: 'pending', approvers: [entry(NOSIG)] }] };
  const noSig = await requestConsent({ ...base, email: NOSIG, own: planOwnSteps(noSigPlan, NOSIG), password: PW });
  assert.equal(noSig.message, `${NO_SAMPLE.vi} ${SELF_MSG.vi.noSampleHint}`);
  assert.equal(noSig.consent, undefined);
});

test('requestConsent shares the approval lockout counter: 4 wrong at submit + 1 wrong at approve locks', { skip }, async () => {
  await redis.del(failKey(ME), lockKey(ME));
  const base = { db, redis, email: ME, own: planOwnSteps(PLAN, ME), companyId: null, lang: 'vi', at: AT };
  try {
    for (let i = 0; i < 4; i += 1) assert.equal((await requestConsent({ ...base, password: 'wrong' })).message, STEP_UP_MSG.vi.wrongPassword);
    assert.equal((await confirmPassword({ db, redis, email: ME, password: 'wrong', lang: 'vi' })).message, STEP_UP_MSG.vi.locked);
    const locked = await requestConsent({ ...base, password: PW });
    assert.equal(locked.message, STEP_UP_MSG.vi.locked);
    assert.equal(locked.consent, undefined);
  } finally { await redis.del(failKey(ME), lockKey(ME)); }
});

test('autoAdvance: own open steps in order, stops at another approver, group entry only, sample re-checked by DB lookup', { skip }, async () => {
  const { consent } = await requestConsent({ db, redis, email: ME, own: planOwnSteps(PLAN, ME), companyId: null, ref: 'TL-1', lang: 'vi', at: AT, password: PW });
  const notes = [];
  const run = (state) => autoAdvance(db, {
    state, companyId: null, now: () => new Date('2026-10-08T03:00:00.000Z'),
    consentOf: (s) => consentFor(s.metadata, { submitterEmail: ME, round: 0, ref: 'TL-1' }),
    pendingOwn: (s, me) => planOwnOpen(s.plan, me),
    approve: async (s, { consent: c, mine, stamp, at, note }) => {
      notes.push(note);
      const plan = applyApproval(s.plan, c.by, { at, signature: stamp.signature }).plan;
      return { plan, metadata: { selfApproval: recordAuto(c, mine, at, planOwnLeft(plan, c.by)) } };
    },
  });
  let out = await run({ plan: PLAN, metadata: { selfApproval: consent } });
  assert.deepEqual(out.auto, [{ step: 1, labels: ['Kiểm tra'], at: '2026-10-08T03:00:00.000Z' }]);
  assert.equal(out.state.plan.steps[0].approvers[0].signature, FAKE_STAMP('https://drive/sa-me'));
  assert.equal(out.state.plan.steps[1].status, 'pending', 'never ahead of another approver');
  // A step that became mine after the consent (flow edited) is not auto-approved: it waits for me by hand
  const gained = structuredClone(out.state.plan);
  gained.steps[1].approvers = [entry(ME)];
  assert.deepEqual((await run({ ...out.state, plan: gained })).auto, [], 'step 2 was never consented');
  out = await run({ ...out.state, plan: applyApproval(out.state.plan, 'other@test.vn', { at: AT }).plan });
  assert.deepEqual(out.auto.map((a) => a.step), [3]);
  assert.deepEqual(out.state.plan.steps[2].approvers.map((a) => a.status), ['approved', 'pending'], 'group step: only my entry');
  assert.deepEqual(out.state.metadata.selfApproval.stamps, [], 'no own step left');
  assert.deepEqual(notes, ['Tự động duyệt khi gửi phiếu (người đề nghị là Kiểm tra)', 'Tự động duyệt khi gửi phiếu (người đề nghị là Nhóm cuối)']);
  assert.deepEqual((await run(out.state)).auto, [], 'nothing left');
  // The sample changed after consent → no auto-approval; that step waits for the requester by hand
  await db.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', 'https://drive/sa-me-new') WHERE LOWER(email) = $1`, [ME]);
  try {
    assert.deepEqual((await run({ plan: PLAN, metadata: { selfApproval: consent } })).auto, []);
  } finally {
    await db.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', 'https://drive/sa-me') WHERE LOWER(email) = $1`, [ME]);
  }
});

test('autoAdvance stops when approve makes no progress (same step and key still pending)', { skip }, async () => {
  const { consent } = await requestConsent({ db, redis, email: ME, own: planOwnSteps(PLAN, ME), companyId: null, ref: 'TL-1', lang: 'vi', at: AT, password: PW });
  let calls = 0;
  const errors = [];
  const orig = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); };
  try {
    const out = await autoAdvance(db, {
      state: { plan: PLAN, metadata: { selfApproval: consent } }, companyId: null,
      consentOf: (s) => consentFor(s.metadata, { submitterEmail: ME, round: 0, ref: 'TL-1' }),
      pendingOwn: (s, me) => planOwnOpen(s.plan, me),
      approve: async (s) => { calls += 1; return s; }, // a broken adapter: nothing changes
    });
    assert.equal(calls, 1);
    assert.deepEqual(out.auto.map((a) => a.step), [1]);
    assert.equal(errors.some((e) => e.includes('no progress')), true);
  } finally { console.error = orig; }
});
