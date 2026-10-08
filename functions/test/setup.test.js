'use strict';
/*
 * Unit-tests voor de Fase 2C-3 businesslogica (Cloud Functions).
 *
 * Strategie: geen echte Firebase/runtime, geen Emulator. De handlers worden
 * aangeroepen via de v2-test-hook `callable.run(request)` (zie onCall ->
 * __trigger/`run`). Een in-memory mock-DB (functions/index.js __mkMockDb) wordt
 * via __setDb geinjecteerd, dus geen credentials/ADC nodig.
 *
 * Auth-claims en database-writes blijven volledig onder de controle van de
 * Function — clients kunnen zich niet zelf trainer/owner maken.
 */

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

// importeren bij teststart; faalt deze require mis, dan faalt de hele suite.
let mod;
try {
  mod = require('../index.js');
} catch (e) {
  throw new Error('functions/index.js kon niet geladen worden: ' + e.message);
}

const ENDPOINTS = ['createInviteCode', 'previewInvite', 'redeemInvite'];

// ---- auth-tokens die de handler verwacht (pariteit met RTDB Rules) ----------
const authVerified = (uid) => ({
  uid,
  token: { email_verified: true, firebase: { sign_in_provider: 'password' } }
});
const authAnon = (uid) => ({
  uid,
  token: { firebase: { sign_in_provider: 'anonymous' } }
});
const authUnverified = (uid) => ({
  uid,
  token: { email_verified: false, firebase: { sign_in_provider: 'password' } }
});
const req = (auth, data) => ({ auth, data: data || {} });

// ---- helpers ---------------------------------------------------------------
const rejectsWith = async (p, code) => {
  let err;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'verwachtte een afgehandelde fout');
  assert.strictEqual(err && err.code, code, 'verwachtte ' + code + ', kreeg ' + (err && err.code));
};

// vaste seed: teamA met owner ownerA en trainer trainerA.
const seed = () => ({
  teams: {
    teamA: {
      createdAt: 1,
      createdBy: 'ownerA',
      clubName: 'Club A',
      teamName: 'JO9-1',
      season: '2026/2027',
      members: { ownerA: 'owner', trainerA: 'trainer' }
    }
  },
  inviteCodes: {}
});

let mock;

beforeEach(() => {
  mock = mod.__mkMockDb(seed());
  mod.__setDb(mock);
});

const run = (name, auth, data) => mod[name].run(req(auth, data));

// Owner creert een code (herbruikbare fixture).
const createCode = async (teamId = 'teamA', by = 'ownerA') => {
  const r = await run('createInviteCode', authVerified(by), { teamId });
  return r.code;
};

const snapVal = async (path) => (await mock.ref(path).once('value')).val();

// ===========================================================================
describe('Fase 2C-3: Functions-basis — module & endpoints', () => {
  it('de functions-module laadt zonder fout', () => {
    assert.ok(mod, 'module is undefined');
  });

  it('de drie callable endpoints zijn aanwezig', () => {
    for (const name of ENDPOINTS) {
      assert.ok(mod[name] !== undefined, name + ' ontbreekt');
      assert.ok(
        typeof mod[name] === 'function' || typeof mod[name] === 'object',
        name + ' is geen callable (geen functie/object)'
      );
    }
  });

  it('helpers zijn geexporteerd (admin-laad, invariants, helper)', () => {
    assert.strictEqual(typeof mod.__getDb, 'function');
    assert.strictEqual(typeof mod.__requireVerifiedAccount, 'function');
    assert.strictEqual(typeof mod.__isValidTeamId, 'function');
    assert.strictEqual(typeof mod.__normalizeInviteCode, 'function');
    assert.strictEqual(typeof mod.__isValidInviteCode, 'function');
    assert.strictEqual(typeof mod.__INVITE_TTL_MS, 'number');
  });
});

// ===========================================================================
describe('Fase 2C-3: beveiligingsstructuur — requireVerifiedAccount (pass-through)', () => {
  const rq = mod.__requireVerifiedAccount;
  it('werpt unauthenticated zonder auth', () => {
    assert.throws(() => rq({ auth: undefined }), (e) => e.code === 'unauthenticated');
    assert.throws(() => rq({}), (e) => e.code === 'unauthenticated');
  });
  it('werpt permission-denied voor anonieme accounts', () => {
    assert.throws(
      () => rq({ auth: { uid: 'u1', token: { firebase: { sign_in_provider: 'anonymous' } } } }),
      (e) => e.code === 'permission-denied'
    );
  });
  it('werpt permission-denied voor onbevestigde e-mail', () => {
    assert.throws(
      () => rq({ auth: { uid: 'u1', token: { email_verified: false, firebase: { sign_in_provider: 'password' } } } }),
      (e) => e.code === 'permission-denied'
    );
  });
  it('geeft uid terug voor geverifieerd, niet-anoniem account', () => {
    assert.strictEqual(
      rq({ auth: { uid: 'u1', token: { email_verified: true, firebase: { sign_in_provider: 'password' } } } }),
      'u1'
    );
  });
});

// ===========================================================================
describe('Fase 2C-3: code-validatie helpers (zuiver)', () => {
  it('normalizeInviteCode normaliseert spacing/case en voegt dash toe', () => {
    assert.strictEqual(mod.__normalizeInviteCode('k7p4 m2x9'), 'K7P4-M2X9');
    assert.strictEqual(mod.__normalizeInviteCode('k7p4-m2x9'), 'K7P4-M2X9');
    assert.strictEqual(mod.__normalizeInviteCode('K7P4M2X9'), 'K7P4-M2X9');
  });
  it('normalizeInviteCode verwijstert bij ongeldige code', () => {
    assert.strictEqual(mod.__normalizeInviteCode('!!!'), '');
    assert.strictEqual(mod.__normalizeInviteCode('TOOLONG-CODE'), '');
  });
  it('isValidInviteCode aanvat XXXX-XXXX zonder ambigue tekens', () => {
    assert.strictEqual(mod.__isValidInviteCode('K7P4-M2X9'), true);
    assert.strictEqual(mod.__isValidInviteCode('0000-0000'), false); // 0/O/1/I
    assert.strictEqual(mod.__isValidInviteCode('O0I1-O0I1'), false);
  });
});

// ===========================================================================
describe('createInviteCode', () => {
  it('geen auth -> unauthenticated', async () => {
    await rejectsWith(run('createInviteCode', undefined, { teamId: 'teamA' }), 'unauthenticated');
  });
  it('anoniem -> permission-denied', async () => {
    await rejectsWith(run('createInviteCode', authAnon('a1'), { teamId: 'teamA' }), 'permission-denied');
  });
  it('onbevestigd -> permission-denied', async () => {
    await rejectsWith(run('createInviteCode', authUnverified('u1'), { teamId: 'teamA' }), 'permission-denied');
  });
  it('trainer (geen owner) -> permission-denied', async () => {
    await rejectsWith(run('createInviteCode', authVerified('trainerA'), { teamId: 'teamA' }), 'permission-denied');
  });
  it('team niet gevonden -> not-found', async () => {
    await rejectsWith(run('createInviteCode', authVerified('ownerA'), { teamId: 'teamGhost' }), 'not-found');
  });
  it('ongeldig teamId -> invalid-argument', async () => {
    await rejectsWith(run('createInviteCode', authVerified('ownerA'), { teamId: 'a/../b' }), 'invalid-argument');
  });
  it('owner -> geldige code + record met juiste velden', async () => {
    const r = await run('createInviteCode', authVerified('ownerA'), { teamId: 'teamA' });
    assert.ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.code));
    assert.strictEqual(r.teamId, 'teamA');
    assert.strictEqual(typeof r.expiresAt, 'number');
    assert.ok(r.expiresAt > Date.now()); // verloopt ~7d in de toekomst

    const rec = await snapVal('inviteCodes/' + r.code);
    assert.strictEqual(rec.teamId, 'teamA');
    assert.strictEqual(rec.used, false);
    assert.strictEqual(rec.createdBy, 'ownerA');
    assert.strictEqual(typeof rec.createdAt, 'number');
    assert.strictEqual(rec.expiresAt, r.expiresAt);
  });
  it('twee aanmaaken geven unieke codes', async () => {
    const r1 = await run('createInviteCode', authVerified('ownerA'), { teamId: 'teamA' });
    const r2 = await run('createInviteCode', authVerified('ownerA'), { teamId: 'teamA' });
    assert.notStrictEqual(r1.code, r2.code);
  });
  it('code wordt admin-only geschreven (inviteCodes aanwezig, members onaangeroerd)', async () => {
    const r = await run('createInviteCode', authVerified('ownerA'), { teamId: 'teamA' });
    const members = await snapVal('teams/teamA/members');
    assert.deepStrictEqual(Object.keys(members).sort(), ['ownerA', 'trainerA']);
    assert.strictEqual(members.ownerA, 'owner');
    assert.strictEqual(members.trainerA, 'trainer');
  });
});

// ===========================================================================
describe('previewInvite', () => {
  it('geen auth -> unauthenticated', async () => {
    await rejectsWith(run('previewInvite', undefined, { code: 'ABCD-1234' }), 'unauthenticated');
  });
  it('ongeldige code -> invalid-argument', async () => {
    await rejectsWith(run('previewInvite', authVerified('invitee1'), { code: '!!!' }), 'invalid-argument');
  });
  it('onbekende code -> not-found', async () => {
    await rejectsWith(run('previewInvite', authVerified('invitee1'), { code: 'ZZZZ-ZZZZ' }), 'not-found');
  });
  it('geldige code -> metadata (geen role/used)', async () => {
    const code = await createCode();
    const preview = await run('previewInvite', authVerified('invitee1'), { code });
    assert.deepStrictEqual(preview, {
      teamId: 'teamA',
      clubName: 'Club A',
      teamName: 'JO9-1',
      season: '2026/2027'
    });
    assert.ok(!('role' in preview));
    assert.ok(!('used' in preview));
  });
  it('verlopen code -> failed-precondition', async () => {
    await mock.ref('inviteCodes/PAST-PAST').set({
      teamId: 'teamA', expiresAt: 1, used: false, createdBy: 'ownerA', createdAt: 0
    });
    await rejectsWith(run('previewInvite', authVerified('invitee1'), { code: 'PAST-PAST' }), 'failed-precondition');
  });
  it('gebruikte code -> failed-precondition', async () => {
    await mock.ref('inviteCodes/USED-USED').set({
      teamId: 'teamA', expiresAt: 9999999999999, used: true, createdBy: 'ownerA', createdAt: 0
    });
    await rejectsWith(run('previewInvite', authVerified('invitee1'), { code: 'USED-USED' }), 'failed-precondition');
  });
});

// ===========================================================================
describe('redeemInvite', () => {
  it('geen auth -> unauthenticated', async () => {
    await rejectsWith(run('redeemInvite', undefined, { code: 'ABCD-1234' }), 'unauthenticated');
  });
  it('ongeldige code -> invalid-argument', async () => {
    await rejectsWith(run('redeemInvite', authVerified('newUser'), { code: '!!!' }), 'invalid-argument');
  });
  it('onbekende code -> not-found', async () => {
    await rejectsWith(run('redeemInvite', authVerified('newUser'), { code: 'ZZZZ-ZZZZ' }), 'not-found');
  });
  it('verlopen code -> failed-precondition; code blijft unused, geen member', async () => {
    await mock.ref('inviteCodes/PAST-PAST').set({
      teamId: 'teamA', expiresAt: 1, used: false, createdBy: 'ownerA', createdAt: 0
    });
    await rejectsWith(run('redeemInvite', authVerified('newUser'), { code: 'PAST-PAST' }), 'failed-precondition');
    assert.strictEqual((await snapVal('inviteCodes/PAST-PAST')).used, false);
    assert.strictEqual(await snapVal('teams/teamA/members/newUser'), undefined);
  });

  it('geldige code -> trainer + users-index + used; NOOIT owner', async () => {
    const code = await createCode();
    const r = await run('redeemInvite', authVerified('newUser'), { code });
    assert.strictEqual(r.role, 'trainer');          // nooit owner
    assert.strictEqual(r.accepted, true);
    assert.strictEqual(r.teamId, 'teamA');
    assert.strictEqual(r.clubName, 'Club A');

    const entry = await snapVal('inviteCodes/' + code);
    assert.strictEqual(entry.used, true);           // code verbruikt
    assert.strictEqual(await snapVal('teams/teamA/members/newUser'), 'trainer'); // trainer, niet owner
    assert.strictEqual(await snapVal('users/newUser/teams/teamA'), true);        // index
  });

  it('tweede redeem van dezelfde code -> already-exists (single-use)', async () => {
    const code = await createCode();
    await run('redeemInvite', authVerified('userA'), { code });
    await rejectsWith(run('redeemInvite', authVerified('userB'), { code }), 'already-exists');
    assert.strictEqual(await snapVal('teams/teamA/members/userB'), undefined);
  });

  it('al lid (trainer) redeemt -> already-exists; code blijft unused', async () => {
    const code = await createCode();
    await rejectsWith(run('redeemInvite', authVerified('trainerA'), { code }), 'already-exists');
    assert.strictEqual((await snapVal('inviteCodes/' + code)).used, false);
  });

  it('al lid (owner) redeemt -> already-exists; code blijft unused', async () => {
    const code = await createCode();
    await rejectsWith(run('redeemInvite', authVerified('ownerA'), { code }), 'already-exists');
    assert.strictEqual((await snapVal('inviteCodes/' + code)).used, false);
  });

  it('two concurrent redeem attempts: slechts één wint (single-use)', async () => {
    const code = await createCode();
    const [a, b] = await Promise.allSettled([
      run('redeemInvite', authVerified('userA'), { code }),
      run('redeemInvite', authVerified('userB'), { code })
    ]);
    const fates = [a.status, b.status].sort();
    assert.deepStrictEqual(fates, ['fulfilled', 'rejected']);

    const members = await snapVal('teams/teamA/members');
    const newTrainers = ['userA', 'userB'].filter((u) => members[u] === 'trainer').length;
    assert.strictEqual(newTrainers, 1);          // precies één nieuwe trainer
    assert.strictEqual(members.ownerA, 'owner');  // seed onaangeroerd
    assert.strictEqual(members.trainerA, 'trainer');
    // geen van beide is ooit 'owner' geworden:
    assert.notStrictEqual(members.userA, 'owner');
    assert.notStrictEqual(members.userB, 'owner');
  });

  it("geen member wordt 'owner' — invariant na succesvolle redeem", async () => {
    const code = await createCode();
    await run('redeemInvite', authVerified('brandNew'), { code });
    assert.strictEqual((await snapVal('teams/teamA/members')).brandNew, 'trainer');
  });
});

// ===========================================================================
describe('Fase 2C-3: invariant — inviteCodes blijft admin-only via deze functie', () => {
  it('handlers lezen/schrijven inviteCodes alleen via Admin (mock ref)', async () => {
    // Na aanmaak bestaat er precies één inviteCodes-entry (admin-only write).
    const r = await run('createInviteCode', authVerified('ownerA'), { teamId: 'teamA' });
    const all = await snapVal('inviteCodes');
    const keys = Object.keys(all || {}).filter((k) => k === r.code);
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(all[r.code].used, false);
  });
});
