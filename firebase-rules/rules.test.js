'use strict';
// Lokale test van de Realtime Database Rules tegen de EMULATOR (127.0.0.1:9000).
// Geen verbinding met het echte Firebase-project. Project-id begint met "demo-".

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { describe, it, before, after, beforeEach } = require('node:test');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const { ref, get, set, update, remove } = require('firebase/database');

const PROJECT_ID = 'demo-wisselmeester-rules';
let env;

const verified = (extra = {}) => ({ email_verified: true, firebase: { sign_in_provider: 'password' }, ...extra });
const unverifiedTok = () => ({ email_verified: false, firebase: { sign_in_provider: 'password' } });
const anonTok = () => ({ firebase: { sign_in_provider: 'anonymous' } });

const as = (uid, tok = verified()) => env.authenticatedContext(uid, tok).database();
const anon = (uid = 'anon1') => as(uid, anonTok());
const noAuth = () => env.unauthenticatedContext().database();

const newTeam = (creator, extra = {}) => ({
  clubName: 'Nieuwe Club',
  teamName: 'JO10-1',
  season: '2026/2027',
  createdAt: 1790000000000,
  createdBy: creator,
  members: { [creator]: 'owner' },
  ...extra
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      host: '127.0.0.1',
      port: 9000,
      rules: fs.readFileSync(path.join(__dirname, 'database.rules.json'), 'utf8')
    }
  });
});

after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.database();
    await set(ref(db, 'teams/teamA'), {
      clubName: 'Club A', teamName: 'JO9-1', season: '2026/2027', createdAt: 1, createdBy: 'ownerA',
      members: { ownerA: 'owner', trainerA: 'trainer' },
      players: { p1: { name: 'Speler A1', history: 0 } },
      matches: { m1: { opponent: 'Tegenstander', date: '2026-10-01' } }
    });
    await set(ref(db, 'teams/teamB'), {
      clubName: 'Club B', teamName: 'JO11-2', season: '2026/2027', createdAt: 2, createdBy: 'ownerB',
      members: { ownerB: 'owner', trainerB: 'trainer' },
      players: { p1: { name: 'Speler B1', history: 0 } },
      matches: { m1: { opponent: 'Andere tegenstander' } }
    });
    await set(ref(db, 'users/ownerA/teams/teamA'), true);
    await set(ref(db, 'users/trainerA/teams/teamA'), true);
    await set(ref(db, 'users/ownerB/teams/teamB'), true);
    await set(ref(db, 'inviteCodes/CODE123456'), { teamId: 'teamA', expiresAt: 9999999999999, used: false });
    await set(ref(db, 'team'), { players: { 0: { id: 1, name: 'Legacy speler', history: 0 } }, matches: { 0: { matchNumber: 1 } } });
  });
});

describe('AUTHENTICATIE', () => {
  it('1. verified owner kan eigen team lezen', async () => {
    const snap = await assertSucceeds(get(ref(as('ownerA'), 'teams/teamA')));
    assert.strictEqual(snap.val().clubName, 'Club A');
  });
  it('2. verified trainer kan eigen team lezen', async () => {
    const snap = await assertSucceeds(get(ref(as('trainerA'), 'teams/teamA')));
    assert.strictEqual(snap.val().teamName, 'JO9-1');
  });
  it('3. unverified gebruiker (wel lid) kan team niet lezen', async () => {
    await assertFails(get(ref(as('trainerA', unverifiedTok()), 'teams/teamA')));
  });
  it('4. anonymous gebruiker kan team niet lezen', async () => {
    await assertFails(get(ref(anon('trainerA'), 'teams/teamA')));
  });
});

describe('TEAM-ISOLATIE', () => {
  it('5. lid van team A kan team A lezen', async () => {
    await assertSucceeds(get(ref(as('trainerA'), 'teams/teamA/players')));
  });
  it('6. lid van team A kan team B niet lezen', async () => {
    await assertFails(get(ref(as('trainerA'), 'teams/teamB')));
    await assertFails(get(ref(as('ownerA'), 'teams/teamB/players')));
    await assertFails(get(ref(as('ownerA'), 'teams/teamB/matches')));
  });
  it('7. lid van team A kan team B niet schrijven', async () => {
    await assertFails(set(ref(as('trainerA'), 'teams/teamB/players/p9'), { name: 'Indringer' }));
    await assertFails(set(ref(as('ownerA'), 'teams/teamB/matches/m9'), { opponent: 'X' }));
    await assertFails(set(ref(as('ownerA'), 'teams/teamB/clubName'), 'Gekaapt'));
    await assertFails(remove(ref(as('ownerA'), 'teams/teamB')));
  });
});

describe('ROLLEN', () => {
  it('8. trainer kan spelers van eigen team wijzigen', async () => {
    await assertSucceeds(set(ref(as('trainerA'), 'teams/teamA/players/p2'), { name: 'Nieuwe speler', history: 0 }));
    await assertSucceeds(set(ref(as('trainerA'), 'teams/teamA/players/p1/history'), 30));
    await assertSucceeds(remove(ref(as('trainerA'), 'teams/teamA/players/p2')));
  });
  it('9. trainer kan wedstrijden van eigen team wijzigen', async () => {
    await assertSucceeds(set(ref(as('trainerA'), 'teams/teamA/matches/m2'), { opponent: 'FC Nieuw', date: '2026-10-08' }));
    await assertSucceeds(remove(ref(as('trainerA'), 'teams/teamA/matches/m1')));
  });
  it('10. trainer kan geen trainer toevoegen', async () => {
    await assertFails(set(ref(as('trainerA'), 'teams/teamA/members/nieuwUid'), 'trainer'));
  });
  it('11. trainer kan zichzelf geen owner maken', async () => {
    await assertFails(set(ref(as('trainerA'), 'teams/teamA/members/trainerA'), 'owner'));
  });
  it('12. trainer kan zichzelf uit het team verwijderen', async () => {
    await assertSucceeds(remove(ref(as('trainerA'), 'teams/teamA/members/trainerA')));
  });
  it('13. owner kan trainer verwijderen', async () => {
    await assertSucceeds(remove(ref(as('ownerA'), 'teams/teamA/members/trainerA')));
  });
  it('14. owner kan team verwijderen', async () => {
    await assertSucceeds(remove(ref(as('ownerA'), 'teams/teamA')));
  });
  it('15. owner kan zichzelf niet zomaar verwijderen', async () => {
    await assertFails(remove(ref(as('ownerA'), 'teams/teamA/members/ownerA')));
  });
});

describe('TEAM AANMAKEN', () => {
  it('16. verified gebruiker kan team aanmaken met zichzelf als enige owner', async () => {
    await assertSucceeds(set(ref(as('newUser'), 'teams/teamNew'), newTeam('newUser')));
  });
  it('16b. aanmaken met index users/{uid}/teams/{teamId} in één atomaire update', async () => {
    await assertSucceeds(update(ref(as('newUser')), {
      'teams/teamNew2': newTeam('newUser'),
      'users/newUser/teams/teamNew2': true
    }));
  });
  it('17. team kan niet worden aangemaakt zonder createdBy', async () => {
    const t = newTeam('newUser'); delete t.createdBy;
    await assertFails(set(ref(as('newUser'), 'teams/teamNew'), t));
  });
  it('18. team kan niet worden aangemaakt met twee owners', async () => {
    await assertFails(set(ref(as('newUser'), 'teams/teamNew'), newTeam('newUser', { members: { newUser: 'owner', anderUid: 'owner' } })));
  });
  it('18b. team kan niet worden aangemaakt met extra trainer (alleen Function mag leden toevoegen)', async () => {
    await assertFails(set(ref(as('newUser'), 'teams/teamNew'), newTeam('newUser', { members: { newUser: 'owner', anderUid: 'trainer' } })));
  });
  it('18c. team kan niet worden aangemaakt met een andere owner dan jezelf', async () => {
    await assertFails(set(ref(as('newUser'), 'teams/teamNew'), newTeam('anderUid')));
  });
  it('19. bestaand teamId kan niet opnieuw worden aangemaakt', async () => {
    await assertFails(set(ref(as('newUser'), 'teams/teamA'), newTeam('newUser')));
    await assertFails(set(ref(as('ownerA'), 'teams/teamA'), newTeam('ownerA')));
  });
  it('19b. unverified gebruiker kan geen team aanmaken', async () => {
    await assertFails(set(ref(as('newUser', unverifiedTok()), 'teams/teamNew'), newTeam('newUser')));
  });
  it('19c. anonymous gebruiker kan geen team aanmaken', async () => {
    await assertFails(set(ref(anon('newUser'), 'teams/teamNew'), newTeam('newUser')));
  });
  it('19d. niet-bestaand team: spelers schrijven zonder team aan te maken mislukt', async () => {
    await assertFails(set(ref(as('newUser'), 'teams/teamGhost/players/p1'), { name: 'Spook' }));
  });
});

// Leest data buiten de Rules om (alleen voor controle van de eindtoestand).
const raw = async p => {
  let v;
  await env.withSecurityRulesDisabled(async ctx => { v = (await get(ref(ctx.database(), p))).val(); });
  return v;
};

describe('ATOMAIRE INDEX-UPDATES (users/{uid}/teams/{teamId})', () => {
  // A. Nieuw team + eigen index in één atomische update
  it('A1. nieuw team aanmaken met zichzelf als createdBy/owner én users/{uid}/teams/{teamId}: true in één update', async () => {
    await assertSucceeds(update(ref(as('newUser')), {
      'teams/teamAtom': newTeam('newUser'),
      'users/newUser/teams/teamAtom': true
    }));
    const team = await raw('teams/teamAtom');
    assert.strictEqual(team.createdBy, 'newUser');
    assert.deepStrictEqual(team.members, { newUser: 'owner' });
    assert.strictEqual(await raw('users/newUser/teams/teamAtom'), true);
  });
  it('A2. atomische update met een andere createdBy/owner dan jezelf wordt geweigerd; er wordt niets geschreven', async () => {
    await assertFails(update(ref(as('newUser')), {
      'teams/teamAtom': newTeam('anderUid'),
      'users/newUser/teams/teamAtom': true
    }));
    assert.strictEqual(await raw('teams/teamAtom'), null);
    assert.strictEqual(await raw('users/newUser'), null);
  });
  it('A3. atomische update: team als nieuwe owner, maar index op naam van een ander wordt geweigerd', async () => {
    await assertFails(update(ref(as('newUser')), {
      'teams/teamAtom': newTeam('newUser'),
      'users/anderUid/teams/teamAtom': true
    }));
    assert.strictEqual(await raw('teams/teamAtom'), null);
    assert.strictEqual(await raw('users/anderUid'), null);
  });

  // B. Alleen een index-ingang voor een bestaand team waarvan je geen lid bent
  it('B1. alleen users/{uid}/teams/{teamId}: true voor bestaand team zonder lid te zijn wordt geweigerd', async () => {
    await assertFails(set(ref(as('newUser'), 'users/newUser/teams/teamB'), true));
    await assertFails(set(ref(as('trainerA'), 'users/trainerA/teams/teamB'), true));
    await assertFails(set(ref(as('ownerA'), 'users/ownerA/teams/teamB'), true));
    assert.strictEqual(await raw('users/newUser'), null);
  });
  it('B2. hetzelfde via een update op de users-node wordt geweigerd', async () => {
    await assertFails(update(ref(as('newUser'), 'users/newUser'), { 'teams/teamB': true }));
    await assertFails(update(ref(as('newUser')), { 'users/newUser/teams/teamB': true }));
    assert.strictEqual(await raw('users/newUser'), null);
  });
  it('B3. index-ingang voor een niet-bestaand team zonder dat je het aanmaakt wordt geweigerd', async () => {
    await assertFails(set(ref(as('newUser'), 'users/newUser/teams/teamNietBestaand'), true));
  });
  it('B4. wel lid (bestaand team A): eigen index-ingang mag (herstel van een ontbrekende index)', async () => {
    await env.withSecurityRulesDisabled(async ctx => { await remove(ref(ctx.database(), 'users/trainerA/teams/teamA')); });
    await assertSucceeds(set(ref(as('trainerA'), 'users/trainerA/teams/teamA'), true));
  });

  // C. Atomische updates die een bestaand team + eigen index combineren zonder lid te zijn
  it('C1. bestaand team: jezelf als trainer toevoegen + index in één update wordt geweigerd', async () => {
    await assertFails(update(ref(as('newUser')), {
      'teams/teamB/members/newUser': 'trainer',
      'users/newUser/teams/teamB': true
    }));
    assert.deepStrictEqual(await raw('teams/teamB/members'), { ownerB: 'owner', trainerB: 'trainer' });
    assert.strictEqual(await raw('users/newUser'), null);
  });
  it('C2. bestaand team: jezelf als owner toevoegen + index in één update wordt geweigerd', async () => {
    await assertFails(update(ref(as('newUser')), {
      'teams/teamB/members/newUser': 'owner',
      'users/newUser/teams/teamB': true
    }));
    assert.deepStrictEqual(await raw('teams/teamB/members'), { ownerB: 'owner', trainerB: 'trainer' });
    assert.strictEqual(await raw('users/newUser'), null);
  });
  it('C3. bestaand team overschrijven als nieuw team (createdBy/owner = jezelf) + index wordt geweigerd', async () => {
    await assertFails(update(ref(as('newUser')), {
      'teams/teamB': newTeam('newUser'),
      'users/newUser/teams/teamB': true
    }));
    const team = await raw('teams/teamB');
    assert.strictEqual(team.createdBy, 'ownerB');
    assert.deepStrictEqual(team.members, { ownerB: 'owner', trainerB: 'trainer' });
    assert.strictEqual(await raw('users/newUser'), null);
  });
  it('C4. bestaand team: createdBy en members-subpaden overschrijven + index wordt geweigerd', async () => {
    await assertFails(update(ref(as('newUser')), {
      'teams/teamB/createdBy': 'newUser',
      'teams/teamB/members': { newUser: 'owner' },
      'users/newUser/teams/teamB': true
    }));
    const team = await raw('teams/teamB');
    assert.strictEqual(team.createdBy, 'ownerB');
    assert.deepStrictEqual(team.members, { ownerB: 'owner', trainerB: 'trainer' });
    assert.strictEqual(await raw('users/newUser'), null);
  });
  it('C5. als lid van team A: team B + eigen index in één update wordt geweigerd', async () => {
    await assertFails(update(ref(as('trainerA')), {
      'teams/teamB/members/trainerA': 'trainer',
      'users/trainerA/teams/teamB': true
    }));
    assert.deepStrictEqual(await raw('teams/teamB/members'), { ownerB: 'owner', trainerB: 'trainer' });
    assert.strictEqual(await raw('users/trainerA/teams/teamB'), null);
  });
});

describe('LEGACY (team/)', () => {
  it('20. authenticated gebruiker kan team/ lezen', async () => {
    const snap = await assertSucceeds(get(ref(as('trainerA'), 'team/players')));
    assert.strictEqual(snap.val()[0].name, 'Legacy speler');
    await assertSucceeds(get(ref(as('iemand', unverifiedTok()), 'team/matches')));
  });
  it('21. authenticated gebruiker kan team/ schrijven', async () => {
    await assertSucceeds(set(ref(as('trainerA'), 'team/players'), [{ id: 1, name: 'Legacy speler', history: 10 }]));
    await assertSucceeds(set(ref(as('trainerA'), 'team/matches'), [{ matchNumber: 2 }]));
  });
  it('22. anonymous gebruiker kan team/ lezen en schrijven (bestaand legacy-gedrag)', async () => {
    await assertSucceeds(get(ref(anon(), 'team/players')));
    await assertSucceeds(set(ref(anon(), 'team/players'), [{ id: 1, name: 'Legacy speler', history: 20 }]));
    await assertSucceeds(set(ref(anon(), 'team/matches'), []));
  });
  it('22b. niet-ingelogde gebruiker kan team/ niet lezen of schrijven', async () => {
    await assertFails(get(ref(noAuth(), 'team/players')));
    await assertFails(set(ref(noAuth(), 'team/players'), []));
  });
});

describe('DATA-INTEGRITEIT', () => {
  it('23. trainer kan clubName en teamName niet wijzigen', async () => {
    await assertFails(set(ref(as('trainerA'), 'teams/teamA/clubName'), 'Andere Club'));
    await assertFails(set(ref(as('trainerA'), 'teams/teamA/teamName'), 'JO99-9'));
  });
  it('24. trainer kan season niet wijzigen (ook owner niet)', async () => {
    await assertFails(set(ref(as('trainerA'), 'teams/teamA/season'), '2030/2031'));
    await assertFails(set(ref(as('ownerA'), 'teams/teamA/season'), '2030/2031'));
  });
  it('25. trainer kan members-rollen niet wijzigen', async () => {
    await assertFails(set(ref(as('trainerA'), 'teams/teamA/members/ownerA'), 'trainer'));
    await assertFails(set(ref(as('trainerA'), 'teams/teamA/members'), { trainerA: 'owner' }));
    await assertFails(remove(ref(as('trainerA'), 'teams/teamA/members/ownerA')));
  });
  it('25b. trainer kan het team niet verwijderen of hele team-node overschrijven', async () => {
    await assertFails(remove(ref(as('trainerA'), 'teams/teamA')));
    await assertFails(set(ref(as('trainerA'), 'teams/teamA'), newTeam('trainerA')));
  });
  it('26. owner kan clubName en teamName wijzigen', async () => {
    await assertSucceeds(set(ref(as('ownerA'), 'teams/teamA/clubName'), 'Club A Nieuw'));
    await assertSucceeds(set(ref(as('ownerA'), 'teams/teamA/teamName'), 'JO9-2'));
  });
  it('26b. owner kan clubName niet leegmaken of te lang maken', async () => {
    await assertFails(set(ref(as('ownerA'), 'teams/teamA/clubName'), ''));
    await assertFails(set(ref(as('ownerA'), 'teams/teamA/clubName'), 'x'.repeat(61)));
  });
  it('27. owner kan zichzelf niet verwijderen of degraderen zonder ownership-transfer', async () => {
    await assertFails(remove(ref(as('ownerA'), 'teams/teamA/members/ownerA')));
    await assertFails(set(ref(as('ownerA'), 'teams/teamA/members/ownerA'), 'trainer'));
  });
  it('27b. owner kan zelf geen lid of tweede owner toevoegen (alleen Function)', async () => {
    await assertFails(set(ref(as('ownerA'), 'teams/teamA/members/nieuwUid'), 'trainer'));
    await assertFails(set(ref(as('ownerA'), 'teams/teamA/members/trainerA'), 'owner'));
  });
  it('27c. onbekende velden onder een team worden geweigerd', async () => {
    await assertFails(set(ref(as('ownerA'), 'teams/teamA/geheim'), 'x'));
  });
});

describe('INVITES', () => {
  it('28. client kan inviteCodes niet rechtstreeks lezen', async () => {
    await assertFails(get(ref(as('ownerA'), 'inviteCodes/CODE123456')));
    await assertFails(get(ref(as('ownerA'), 'inviteCodes')));
    await assertFails(get(ref(as('trainerA'), 'inviteCodes')));
  });
  it('29. client kan inviteCodes niet rechtstreeks schrijven', async () => {
    await assertFails(set(ref(as('ownerA'), 'inviteCodes/NIEUW1234'), { teamId: 'teamA', expiresAt: 9999999999999, used: false }));
    await assertFails(set(ref(as('ownerA'), 'inviteCodes/CODE123456/used'), true));
    await assertFails(remove(ref(as('ownerA'), 'inviteCodes/CODE123456')));
  });
});

describe('EXTRA: users en algemene afscherming', () => {
  it('E1. gebruiker kan eigen users-node lezen, die van een ander niet', async () => {
    await assertSucceeds(get(ref(as('ownerA'), 'users/ownerA')));
    await assertFails(get(ref(as('ownerA'), 'users/ownerB')));
  });
  it('E2. gebruiker kan geen index-ingang voor een ander team op eigen naam zetten', async () => {
    await assertFails(set(ref(as('newUser'), 'users/newUser/teams/teamB'), true));
  });
  it('E3. gebruiker kan niet naar users/{andere uid} schrijven', async () => {
    await assertFails(set(ref(as('ownerA'), 'users/ownerB/teams/teamA'), true));
  });
  it('E4. gebruiker kan eigen index-ingang verwijderen', async () => {
    await assertSucceeds(remove(ref(as('trainerA'), 'users/trainerA/teams/teamA')));
  });
  it('E5. teams en root zijn niet lijstbaar', async () => {
    await assertFails(get(ref(as('ownerA'), 'teams')));
    await assertFails(get(ref(as('ownerA'))));
  });
  it('E6. niet-ingelogd: geen toegang tot teams', async () => {
    await assertFails(get(ref(noAuth(), 'teams/teamA')));
  });
  it('E7. onbekend root-pad is geweigerd', async () => {
    await assertFails(set(ref(as('ownerA'), 'iets/anders'), 1));
    await assertFails(get(ref(as('ownerA'), 'iets')));
  });
});
