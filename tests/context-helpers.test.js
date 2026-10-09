'use strict';
// Test van de context- en padhelpers (Fase 2A) uit index.html.
// Haalt het blok tussen BEGIN/END CONTEXT HELPERS uit index.html en voert het uit in een
// geisoleerde VM. Geen browser, geen netwerk, geen Firebase.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');
const { describe, it, before } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let ctx;
const alerts = [];
const run = code => vm.runInContext(code, ctx);

before(() => {
  const m = html.match(/\/\/ BEGIN CONTEXT HELPERS([\s\S]*?)\/\/ END CONTEXT HELPERS/);
  assert.ok(m, 'helperblok niet gevonden in index.html');
  const s = html.match(/\/\/ BEGIN CONTEXT STATE([\s\S]*?)\/\/ END CONTEXT STATE/);
  assert.ok(s, 'state-blok niet gevonden in index.html');
  ctx = vm.createContext({ console: { warn() {}, info() {}, log() {}, error() {} }, alert(msg) { alerts.push(String(msg)); } });
  vm.runInContext(m[1], ctx);
  vm.runInContext(s[1], ctx);
  // Fase A: default is IDLE_CONTEXT. Legacy-code en -tests blijven geldig;
  // zet de VM-baseline expliciet naar LEGACY_CONTEXT. De idle-tests zetten
  // zelf (IDLE_CONTEXT).
  run('activeContext = LEGACY_CONTEXT');
});

describe('LEGACY-context (standaard)', () => {
  it('activeContext is standaard LEGACY_CONTEXT', () => {
    assert.strictEqual(run('activeContext === LEGACY_CONTEXT'), true);
    assert.deepStrictEqual(JSON.parse(run('JSON.stringify(LEGACY_CONTEXT)')), { mode: 'legacy', teamId: null });
  });
  it('dataPath("players") = "team/players"', () => {
    assert.strictEqual(run('dataPath("players")'), 'team/players');
  });
  it('dataPath("matches") = "team/matches"', () => {
    assert.strictEqual(run('dataPath("matches")'), 'team/matches');
  });
  it('storageKey geeft exact de huidige localStorage-sleutels', () => {
    assert.strictEqual(run('storageKey("players")'), 'jo9_players');
    assert.strictEqual(run('storageKey("matches")'), 'jo9_matches');
    assert.strictEqual(run('storageKey("match_counter")'), 'jo9_match_counter');
    assert.strictEqual(run('storageKey("storage_version")'), 'jo9_storage_version');
  });
});

describe('Teamcontext (nog niet in gebruik, alleen via parameter getest)', () => {
  it('geldig teamId: dataPath', () => {
    assert.strictEqual(run('dataPath("players", {mode:"team", teamId:"-Nabc_123"})'), 'teams/-Nabc_123/players');
    assert.strictEqual(run('dataPath("matches", {mode:"team", teamId:"team1"})'), 'teams/team1/matches');
  });
  it('geldig teamId: storageKey', () => {
    assert.strictEqual(run('storageKey("players", {mode:"team", teamId:"team1"})'), 'jo9_team_team1_players');
    assert.strictEqual(run('storageKey("matches", {mode:"team", teamId:"team1"})'), 'jo9_team_team1_matches');
    assert.strictEqual(run('storageKey("match_counter", {mode:"team", teamId:"team1"})'), 'jo9_team_team1_match_counter');
    assert.strictEqual(run('storageKey("storage_version", {mode:"team", teamId:"team1"})'), 'jo9_team_team1_storage_version');
  });
  it('isValidTeamId accepteert push-achtige id\'s en weigert de rest', () => {
    for (const ok of ['team1', '-OaBcD_12', 'A', 'x'.repeat(64)]) assert.strictEqual(run(`isValidTeamId(${JSON.stringify(ok)})`), true, ok);
    for (const bad of ['', '../x', 'a/b', 'a.b', '$x', 'a#b', 'a[b]', ' x', 'x'.repeat(65)]) assert.strictEqual(run(`isValidTeamId(${JSON.stringify(bad)})`), false, JSON.stringify(bad));
    for (const bad of ['null', 'undefined', '123', '{}', '[]']) assert.strictEqual(run(`isValidTeamId(${bad})`), false, bad);
  });
});

describe('Ongeldige teamId: fout, nooit stilzwijgend legacy', () => {
  const bad = ['""', '"../x"', '"a/b"', 'null', 'undefined', '"a.b"', '"x".repeat(65)'];
  for (const b of bad) {
    it(`dataPath met teamId ${b} gooit een fout`, () => {
      assert.throws(() => run(`dataPath("players", {mode:"team", teamId:${b}})`), /Ongeldig teamId/);
      assert.throws(() => run(`dataPath("matches", {mode:"team", teamId:${b}})`), /Ongeldig teamId/);
    });
    it(`storageKey met teamId ${b} gooit een fout`, () => {
      assert.throws(() => run(`storageKey("players", {mode:"team", teamId:${b}})`), /Ongeldig teamId/);
    });
  }
  it('ongeldige of ontbrekende context gooit een fout', () => {
    assert.throws(() => run('dataPath("players", {mode:"bogus"})'), /Ongeldige context/);
    assert.throws(() => run('dataPath("players", {})'), /Ongeldige context/);
    assert.throws(() => run('dataPath("players", null)'), /Ongeldige context/);
    assert.throws(() => run('storageKey("players", {mode:"bogus"})'), /Ongeldige context/);
  });
  it('een actieve teamcontext met ongeldig id valt NIET terug op legacy', () => {
    run('activeContext = {mode:"team", teamId:"../x"}');
    try {
      assert.throws(() => run('dataPath("players")'), /Ongeldig teamId/);
      assert.throws(() => run('storageKey("matches")'), /Ongeldig teamId/);
    } finally {
      run('activeContext = LEGACY_CONTEXT');
    }
    assert.strictEqual(run('dataPath("players")'), 'team/players');
  });
});

describe('Onbekende kindwaarde', () => {
  it('dataPath met onbekend kind gooit een fout', () => {
    for (const k of ['"teams"', '"foo"', '""', 'undefined', 'null', '"Players"', '"match_counter"', '"../team"']) {
      assert.throws(() => run(`dataPath(${k})`), /Onbekend datatype/, k);
    }
  });
  it('storageKey met onbekend kind gooit een fout', () => {
    for (const k of ['"foo"', '""', 'undefined', 'null', '"Players"', '"../x"']) {
      assert.throws(() => run(`storageKey(${k})`), /Onbekende opslagsleutel/, k);
    }
  });
});

describe('index.html: alle bestaande literals zijn vervangen', () => {
  it('geen Firebase path literals meer buiten de helpers', () => {
    const outside = html.replace(/\/\/ BEGIN CONTEXT HELPERS[\s\S]*?\/\/ END CONTEXT HELPERS/, '');
    assert.strictEqual((outside.match(/"team\/players"/g) || []).length, 0);
    assert.strictEqual((outside.match(/"team\/matches"/g) || []).length, 0);
  });
  it('geen losse localStorage-sleutelliteral meer buiten de helpers', () => {
    const outside = html.replace(/\/\/ BEGIN CONTEXT HELPERS[\s\S]*?\/\/ END CONTEXT HELPERS/, '');
    assert.strictEqual((outside.match(/"jo9_(players|matches|match_counter|storage_version)"/g) || []).length, 0);
  });
  it('dataPath wordt 6x gebruikt en storageKey 15x (buiten de definitie)', () => {
    const outside = html.replace(/\/\/ BEGIN CONTEXT HELPERS[\s\S]*?\/\/ END CONTEXT HELPERS/, '');
    assert.strictEqual((outside.match(/dataPath\("(players|matches)"\)/g) || []).length, 6);
    assert.strictEqual((outside.match(/storageKey\("(players|matches|match_counter|storage_version)"\)/g) || []).length, 15);
  });
  it('activeContext wordt alleen in het blok CONTEXT SWITCH toegewezen (setActiveContext)', () => {
    const stripped = html
      .replace(/\/\/ BEGIN CONTEXT HELPERS[\s\S]*?\/\/ END CONTEXT HELPERS/, '')
      .replace(/\/\/ BEGIN CONTEXT SWITCH[\s\S]*?\/\/ END CONTEXT SWITCH/, '');
    assert.strictEqual((stripped.match(/activeContext\s*=[^=]/g) || []).length, 0);
    const sw = html.match(/\/\/ BEGIN CONTEXT SWITCH([\s\S]*?)\/\/ END CONTEXT SWITCH/)[1];
    assert.strictEqual((sw.match(/activeContext\s*=[^=]/g) || []).length, 1);
  });
});

describe('Fase 2B: normalizeContext en schrijfpoort', () => {
  it('normalizeContext: legacy geeft LEGACY_CONTEXT terug', () => {
    assert.strictEqual(run('normalizeContext({mode:"legacy"}) === LEGACY_CONTEXT'), true);
  });
  it('normalizeContext: geldig team geeft een bevroren nieuw object', () => {
    assert.deepStrictEqual(JSON.parse(run('JSON.stringify(normalizeContext({mode:"team", teamId:"-Nab_1"}))')), { mode: 'team', teamId: '-Nab_1' });
    assert.strictEqual(run('Object.isFrozen(normalizeContext({mode:"team", teamId:"t1"}))'), true);
  });
  it('normalizeContext: ongeldige invoer gooit een fout', () => {
    for (const bad of ['undefined', 'null', '"team"', '42', '{}', '{mode:"bogus"}', '{mode:"team"}', '{mode:"team", teamId:""}', '{mode:"team", teamId:"../x"}', '{mode:"team", teamId:"a/b"}', '{mode:"team", teamId:5}']) {
      assert.throws(() => run(`normalizeContext(${bad})`), /Ongeldig/, bad);
    }
  });
  it('canWrite: legacy altijd true (ook zonder syncReady)', () => {
    assert.strictEqual(run('syncReady = false; canWrite()'), true);
  });
  it('canWrite: team alleen true als syncReady true is', () => {
    run('activeContext = {mode:"team", teamId:"t1"}; syncReady = false');
    try {
      assert.strictEqual(run('canWrite()'), false);
      run('syncReady = true');
      assert.strictEqual(run('canWrite()'), true);
    } finally {
      run('activeContext = LEGACY_CONTEXT; syncReady = false');
    }
  });
  it('assertWritable: team niet ready geeft false en een melding; legacy geeft true zonder melding', () => {
    alerts.length = 0;
    assert.strictEqual(run('assertWritable("test")'), true);
    assert.strictEqual(alerts.length, 0);
    run('activeContext = {mode:"team", teamId:"t1"}; syncReady = false');
    try {
      assert.strictEqual(run('assertWritable("test")'), false);
      assert.strictEqual(alerts.length, 1);
    } finally {
      run('activeContext = LEGACY_CONTEXT');
    }
  });
});

describe('Fase 2B: statische controles op index.html', () => {
  const code = html;
  it('setActiveContext heeft geen URL-parameter of localStorage-opslag van de teamkeuze', () => {
    const sw = html.match(/\/\/ BEGIN CONTEXT SWITCH([\s\S]*?)\/\/ END CONTEXT SWITCH/)[1];
    assert.ok(!/localStorage\.setItem/.test(sw));
    assert.ok(!/location\.(search|hash)|URLSearchParams/.test(code));
  });
  it('resetSeason weigert in teammodus vóór de bevestigingsvraag', () => {
    const body = html.match(/async function resetSeason\(\) \{([\s\S]*?)const confirmed =\s*confirm/)[1];
    assert.ok(/activeContext\.mode !== "legacy"/.test(body));
    assert.ok(/return;/.test(body));
  });
  it('alle schrijfacties hebben de schrijfpoort', () => {
    for (const fn of ['finishMatch', 'deleteMatch', 'deletePlayer', 'addPlayer']) {
      const re = new RegExp('function ' + fn + '\\([^)]*\\) \\{[\\s\\S]{0,300}?assertWritable\\("' + fn + '"\\)');
      assert.ok(re.test(html), fn);
    }
    assert.ok(/function savePlayers\(\) \{\s*if \(!canWrite\(\)\)/.test(html));
    assert.ok(/function saveMatches\(\) \{\s*if \(!canWrite\(\)\)/.test(html));
    assert.ok(/async function savePlayersToFirebase\(playerList\) \{\s*if \(!canWrite\(\)\)/.test(html));
    assert.ok(/async function saveMatchesToFirebase\(matchList, options\) \{\s*if \(!canWrite\(\)\)/.test(html));
  });
  it('legacy-matchnummering gebruikt nog steeds jo9_match_counter; team gebruikt max+1', () => {
    assert.ok(/activeContext\.mode === "legacy"\) \{\s*matchNumber =\s*Number\(\s*localStorage\.getItem\(storageKey\("match_counter"\)\)/.test(html));
    assert.ok(/Math\.max\(max, Number\(m && m\.matchNumber\) \|\| 0\)/.test(html));
  });
});

describe('Idle-context (Fase A): geen legacy, geen write, geen sync', () => {
  // Laadt ALLEEN runInitialSync (via marker) + de al gemoduleerde helpers.
  // runLegacySync/runTeamSync worden hier ALLES stubs — een idle-context mag
  // ze nooit aanroepen. Dit is een DIREKE aanroep van runInitialSync().
  const setIdle = () => run('activeContext = IDLE_CONTEXT; syncReady = true; restorePending = false');
  const restore = () => run('activeContext = LEGACY_CONTEXT; syncReady = false; restorePending = false');

  before(() => {
    // runInitialSync staat in een SYNCHRONISATIE-blok; laad het in de VM.
    // runLegacySync/runTeamSync blijven undefined (worden stubs per test).
    const m = html.match(new RegExp('// BEGIN RUN INITIAL SYNC([\\s\\S]*?)// END RUN INITIAL SYNC'));
    assert.ok(m, 'RUN INITIAL SYNC-blok niet gevonden in index.html');
    vm.runInContext(m[1], ctx);
  });

  it('normalizeContext({mode:"idle"}) -> IDLE_CONTEXT (hergebruik)', () => {
    assert.strictEqual(run('normalizeContext({mode:"idle"}) === IDLE_CONTEXT'), true);
    assert.strictEqual(run('normalizeContext({mode:"idle", teamId:null}) === IDLE_CONTEXT'), true);
  });

  it('canWrite() is false in idle (ook met syncReady=true)', () => {
    setIdle();
    try { assert.strictEqual(run('canWrite()'), false); }
    finally { restore(); }
  });

  it('assertWritable in idle: false + melding', () => {
    alerts.length = 0;
    setIdle();
    try {
      assert.strictEqual(run('assertWritable("test")'), false);
      assert.strictEqual(alerts.length, 1);
    } finally { restore(); }
  });

  it('dataPath/storageKey werpen voor idle (safe-net checkContext)', () => {
    setIdle();
    try {
      assert.throws(() => run('dataPath("players")'), /Ongeldige context/);
      assert.throws(() => run('dataPath("players", IDLE_CONTEXT)'), /Ongeldige context/);
      assert.throws(() => run('storageKey("matches")'), /Ongeldige context/);
    } finally { restore(); }
  });

  it('statisch: runLegacySync heeft precies 1 call-site (def + legacy-tak)', () => {
    // runLegacySync( wordt aangeroepen in de legacy-tak van runInitialSync
    // EN is dat de enige call-site; idle bereikt het niet.
    assert.strictEqual((html.match(/runLegacySync\(/g) || []).length, 2);
  });

  it('statisch: runInitialSync heeft een idle-guard (return "blocked") VOOR de legacy-tak', () => {
    assert.ok(
      /async function runInitialSync([\s\S]*?)activeContext\.mode === "idle"([\s\S]*?)return "blocked"([\s\S]*?)activeContext\.mode === "legacy"\s*\)\s*\{\s*return runLegacySync/.test(html),
      'idle-guard moet voor de legacy-call staan'
    );
  });

  it('GEDRAG: directe aanroep runInitialSync() in idle roept runLegacySync/runTeamSync NIET aan', async () => {
    run('activeContext = IDLE_CONTEXT');
    const spies = { legacy: 0, team: 0 };
    ctx.runLegacySync = () => { spies.legacy++; };
    ctx.runTeamSync = () => { spies.team++; };
    const result = await run('runInitialSync(1)');
    assert.strictEqual(result, 'blocked');
    assert.strictEqual(spies.legacy, 0, 'runLegacySync mag niet worden aangeroepen');
    assert.strictEqual(spies.team, 0, 'runTeamSync mag niet worden aangeroepen');
    delete ctx.runLegacySync; delete ctx.runTeamSync;
    restore();
  });
});
