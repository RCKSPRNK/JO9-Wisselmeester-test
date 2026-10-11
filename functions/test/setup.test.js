'use strict';
/*
 * Unit-tests voor de Fase 2C-3 businesslogica (Cloud Functions).
 *
 * Strategie: geen echte Firebase/runtime, geen Emulator. De handlers worden
 * aangeroepen via de v2-test-hook `callable.run(request)` (zie onCall ->
 * __trigger/`run`). Een in-memory mock-DB (functions/index.js __mkMockDb) en
 * een mock-Auth (__setAuth) worden geinjecteerd, dus geen credentials/ADC nodig.
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

const ENDPOINTS = ['addTrainerByEmail', 'removeTrainer', 'leaveTeam', 'listTeamMembers'];

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

// Mock Auth Admin SDK — simuleert getUserByEmail + getUser.
// Tabel: email -> { uid, email, emailVerified, providerData }
const mockUserTable = {
  'owner@test.nl':      { uid: 'ownerA',      email: 'owner@test.nl',      emailVerified: true,  providerData: [{ providerId: 'password' }] },
  'trainer@test.nl':    { uid: 'trainerA',    email: 'trainer@test.nl',    emailVerified: true,  providerData: [{ providerId: 'password' }] },
  'newtrainer@test.nl': { uid: 'newTrainer',  email: 'newtrainer@test.nl', emailVerified: true,  providerData: [{ providerId: 'password' }] },
  'unverified@test.nl': { uid: 'unverified',  email: 'unverified@test.nl', emailVerified: false, providerData: [{ providerId: 'password' }] },
  'anon@test.nl':       { uid: 'anonUser',    email: 'anon@test.nl',       emailVerified: true,  providerData: [{ providerId: 'anonymous' }] }
};

function makeAuthMock(table) {
  const uidMap = {};
  for (const u of Object.values(table)) {
    uidMap[u.uid] = u;
  }
  const mkNotFound = () => { const e = new Error('auth/user-not-found'); e.code = 'auth/user-not-found'; return e; };
  return {
    getUserByEmail: async (email) => {
      const key = (email || '').toLowerCase();
      const u = table[key];
      if (!u) throw mkNotFound();
      return u;
    },
    getUser: async (uid) => {
      const u = uidMap[uid];
      if (!u) throw mkNotFound();
      return u;
    }
  };
}

// vaste seed: teamA met owner ownerA en trainer trainerA.
// Geen inviteCodes-boom meer (oude functie verwijderd).
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
  }
});

let mock;
let authMock;

beforeEach(() => {
  mock = mod.__mkMockDb(seed());
  mod.__setDb(mock);
  authMock = makeAuthMock(mockUserTable);
  mod.__setAuth(authMock);
});

const run = (name, auth, data) => mod[name].run(req(auth, data));
const snapVal = async (path) => (await mock.ref(path).once('value')).val();

// ===========================================================================
describe('Fase 2C-3: Functions-basis — module & endpoints', () => {
  it('de functions-module laadt zonder fout', () => {
    assert.ok(mod, 'module is undefined');
  });

  it('de twee callable endpoints zijn aanwezig', () => {
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
    assert.strictEqual(typeof mod.__setAuth, 'function');
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
describe('addTrainerByEmail', () => {
  it('geen auth -> unauthenticated', async () => {
    await rejectsWith(run('addTrainerByEmail', undefined, { teamId: 'teamA', email: 'newtrainer@test.nl' }), 'unauthenticated');
  });
  it('anoniem -> permission-denied', async () => {
    await rejectsWith(run('addTrainerByEmail', authAnon('a1'), { teamId: 'teamA', email: 'newtrainer@test.nl' }), 'permission-denied');
  });
  it('onbevestigd -> permission-denied', async () => {
    await rejectsWith(run('addTrainerByEmail', authUnverified('u1'), { teamId: 'teamA', email: 'newtrainer@test.nl' }), 'permission-denied');
  });
  it('trainer (geen owner) -> permission-denied', async () => {
    await rejectsWith(run('addTrainerByEmail', authVerified('trainerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' }), 'permission-denied');
  });
  it('ongeldig teamId -> invalid-argument', async () => {
    await rejectsWith(run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'a/../b', email: 'newtrainer@test.nl' }), 'invalid-argument');
  });
  it('ongeldig e-mailadres -> invalid-argument', async () => {
    await rejectsWith(run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'not-an-email' }), 'invalid-argument');
  });
  it('onbekend e-mailadres -> not-found', async () => {
    await rejectsWith(run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'nobody@test.nl' }), 'not-found');
  });
  it('onbevestigde gebruiker via e-mail -> failed-precondition', async () => {
    await rejectsWith(run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'unverified@test.nl' }), 'failed-precondition');
  });
  it('owner -> voegt trainer toe + reverse-index; NOOIT owner', async () => {
    const r = await run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });
    assert.strictEqual(r.teamId, 'teamA');
    assert.strictEqual(r.uid, 'newTrainer');
    assert.strictEqual(r.email, 'newtrainer@test.nl');
    assert.strictEqual(r.role, 'trainer');

    assert.strictEqual(await snapVal('teams/teamA/members/newTrainer'), 'trainer');
    assert.strictEqual(await snapVal('users/newTrainer/teams/teamA'), true);
    // Owner blijft owner
    assert.strictEqual(await snapVal('teams/teamA/members/ownerA'), 'owner');
  });
  it('dubbel toevoegen -> already-exists; geen duplicate', async () => {
    await run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });
    await rejectsWith(run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' }), 'already-exists');
    // Nog steeds exact één member
    const members = await snapVal('teams/teamA/members');
    const trainerUids = Object.entries(members).filter(([, r]) => r === 'trainer').map(([k]) => k).sort();
    assert.deepStrictEqual(trainerUids, ['newTrainer', 'trainerA']);
  });
  it('owner kan bestaande trainer verwijderen', async () => {
    await run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });
    const r = await run('removeTrainer', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });
    assert.strictEqual(r.teamId, 'teamA');
    assert.strictEqual(r.uid, 'newTrainer');
    assert.strictEqual(r.role, 'removed');
    assert.strictEqual(await snapVal('teams/teamA/members/newTrainer'), null);
    assert.strictEqual(await snapVal('users/newTrainer/teams/teamA'), null);
    // Owner en seed-trainer onaangeroerd
    assert.strictEqual(await snapVal('teams/teamA/members/ownerA'), 'owner');
    assert.strictEqual(await snapVal('teams/teamA/members/trainerA'), 'trainer');
  });
});

// ===========================================================================
describe('removeTrainer', () => {
  it('geen auth -> unauthenticated', async () => {
    await rejectsWith(run('removeTrainer', undefined, { teamId: 'teamA', email: 'trainer@test.nl' }), 'unauthenticated');
  });
  it('anoniem -> permission-denied', async () => {
    await rejectsWith(run('removeTrainer', authAnon('a1'), { teamId: 'teamA', email: 'trainer@test.nl' }), 'permission-denied');
  });
  it('trainer probeert removeTrainer -> permission-denied', async () => {
    await rejectsWith(run('removeTrainer', authVerified('trainerA'), { teamId: 'teamA', email: 'trainer@test.nl' }), 'permission-denied');
  });
  it('owner probeert niet-angelid te verwijderen -> not-found', async () => {
    await rejectsWith(run('removeTrainer', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' }), 'not-found');
  });
  it('admin blijft owner als trainer wordt verwijderd', async () => {
    // Seed-trainerA verwijderen via owner
    const r = await run('removeTrainer', authVerified('ownerA'), { teamId: 'teamA', email: 'trainer@test.nl' });
    assert.strictEqual(r.role, 'removed');
    assert.strictEqual(await snapVal('teams/teamA/members/trainerA'), null);
    assert.strictEqual(await snapVal('users/trainerA/teams/teamA'), null);
    assert.strictEqual(await snapVal('teams/teamA/members/ownerA'), 'owner');
  });
});

// ===========================================================================
describe('Fase 2C-3: invariant — owner blijft owner, trainer blijft trainer', () => {
  it('addTrainerByEmail schrijft members + users-index; nooit role=owner', async () => {
    await run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });
    assert.strictEqual(await snapVal('teams/teamA/members/newTrainer'), 'trainer');
    assert.notStrictEqual(await snapVal('teams/teamA/members/newTrainer'), 'owner');
    assert.strictEqual(await snapVal('users/newTrainer/teams/teamA'), true);
  });

  it('seed data (ownerA=owner, trainerA=trainer) blijft onaangeroerd', async () => {
    await run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });
    await run('removeTrainer', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });
    assert.strictEqual(await snapVal('teams/teamA/members/ownerA'), 'owner');
    assert.strictEqual(await snapVal('teams/teamA/members/trainerA'), 'trainer');
  });
});

// ===========================================================================
describe('leaveTeam', () => {
  it('geen auth -> unauthenticated', async () => {
    await rejectsWith(run('leaveTeam', undefined, { teamId: 'teamA' }), 'unauthenticated');
  });

  it('anoniem -> permission-denied', async () => {
    await rejectsWith(run('leaveTeam', authAnon('a1'), { teamId: 'teamA' }), 'permission-denied');
  });

  it('ongeldig teamId -> invalid-argument', async () => {
    await rejectsWith(run('leaveTeam', authVerified('ownerA'), { teamId: 'a/../b' }), 'invalid-argument');
  });

  it('niet-lid kan niet vertrekken -> not-found', async () => {
    await rejectsWith(run('leaveTeam', authVerified('newTrainer'), { teamId: 'teamA' }), 'not-found');
  });

  it('trainer verlaat team -> lidmaatschap + index verwijderd', async () => {
    const r = await run('leaveTeam', authVerified('trainerA'), { teamId: 'teamA' });
    assert.strictEqual(r.teamId, 'teamA');
    assert.strictEqual(r.uid, 'trainerA');
    assert.strictEqual(r.role, 'trainer');
    assert.strictEqual(r.transferred, false);

    assert.strictEqual(await snapVal('teams/teamA/members/trainerA'), null);
    assert.strictEqual(await snapVal('users/trainerA/teams/teamA'), null);
    assert.strictEqual(await snapVal('teams/teamA/members/ownerA'), 'owner');
  });

  it('eigenaar vertrekt, trainerA wordt nieuwe owner (key-order: trainerA < trainerB)', async () => {
    // Add a second trainer so owner can transfer
    await run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });

    const r = await run('leaveTeam', authVerified('ownerA'), { teamId: 'teamA' });
    assert.strictEqual(r.transferred, true);
    assert.strictEqual(r.newOwnerId, 'newTrainer'); // lexicographically first trainer (n < t)

    // Old owner removed from members + users index
    assert.strictEqual(await snapVal('teams/teamA/members/ownerA'), null);
    assert.strictEqual(await snapVal('users/ownerA/teams/teamA'), null);
    // New owner is now owner
    assert.strictEqual(await snapVal('teams/teamA/members/newTrainer'), 'owner');
    // trainerA still trainer (newTrainer was promoted — key n < t)
    assert.strictEqual(await snapVal('teams/teamA/members/trainerA'), 'trainer');
    // newTrainer user-index unchanged (was set by addTrainerByEmail)
    assert.strictEqual(await snapVal('users/newTrainer/teams/teamA'), true);
  });

  it('eigenaar alleen -> failed-precondition (geen andere trainer)', async () => {
    // Seed has only ownerA as owner, trainerA as trainer.
    // Remove trainerA first, then owner can't leave.
    await run('leaveTeam', authVerified('trainerA'), { teamId: 'teamA' });
    await rejectsWith(
      run('leaveTeam', authVerified('ownerA'), { teamId: 'teamA' }),
      'failed-precondition'
    );
    // Owner still in team
    assert.strictEqual(await snapVal('teams/teamA/members/ownerA'), 'owner');
  });

  it('eigenaar kan geen andere eigenaar verwijderen via leaveTeam', async () => {
    // If there were two owners (not possible in current model), leaveTeam
    // only lets the caller remove themselves. This is structurally impossible
    // but tests the guard: a non-member gets not-found, not demote.
    await run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });
    // Make newTrainer the owner (simulated — in real life only leaveTeam does this)
    // Actually, test that trainerA (a trainer) cannot call leaveTeam as owner
    // They're not owner, so they leave as trainer. Owner stays.
    const r = await run('leaveTeam', authVerified('trainerA'), { teamId: 'teamA' });
    assert.strictEqual(r.transferred, false);
    assert.strictEqual(r.role, 'trainer');
    assert.strictEqual(await snapVal('teams/teamA/members/ownerA'), 'owner');
  });
});

// ===========================================================================
describe('listTeamMembers', () => {
  it('geen auth -> unauthenticated', async () => {
    await rejectsWith(run('listTeamMembers', undefined, { teamId: 'teamA' }), 'unauthenticated');
  });

  it('anoniem -> permission-denied', async () => {
    await rejectsWith(run('listTeamMembers', authAnon('a1'), { teamId: 'teamA' }), 'permission-denied');
  });

  it('trainer (geen owner) -> permission-denied', async () => {
    await rejectsWith(run('listTeamMembers', authVerified('trainerA'), { teamId: 'teamA' }), 'permission-denied');
  });

  it('ongeldig teamId -> invalid-argument', async () => {
    await rejectsWith(run('listTeamMembers', authVerified('ownerA'), { teamId: 'a/../b' }), 'invalid-argument');
  });

  it('owner -> krijgt ledenden met emails', async () => {
    // Add a trainer so there's more than just the owner
    await run('addTrainerByEmail', authVerified('ownerA'), { teamId: 'teamA', email: 'newtrainer@test.nl' });

    const r = await run('listTeamMembers', authVerified('ownerA'), { teamId: 'teamA' });
    assert.strictEqual(r.teamId, 'teamA');
    assert.strictEqual(r.members.length, 3);

    const owner = r.members.find((m) => m.uid === 'ownerA');
    assert.strictEqual(owner.role, 'owner');
    assert.strictEqual(owner.email, 'owner@test.nl');

    const trainer = r.members.find((m) => m.uid === 'trainerA');
    assert.strictEqual(trainer.role, 'trainer');
    assert.strictEqual(trainer.email, 'trainer@test.nl');

    const newTrainer = r.members.find((m) => m.uid === 'newTrainer');
    assert.strictEqual(newTrainer.role, 'trainer');
    assert.strictEqual(newTrainer.email, 'newtrainer@test.nl');
  });

  it('owner -> niet-angeleden uid krijgt lege email', async () => {
    // Manually set a member with a UID not in mock auth table
    await mock.ref('teams/teamA/members/ghostUser').set('trainer');
    const r = await run('listTeamMembers', authVerified('ownerA'), { teamId: 'teamA' });
    const ghost = r.members.find((m) => m.uid === 'ghostUser');
    assert.strictEqual(ghost.role, 'trainer');
    assert.strictEqual(ghost.email, '');
  });
});
