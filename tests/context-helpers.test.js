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
const run = code => vm.runInContext(code, ctx);

before(() => {
  const m = html.match(/\/\/ BEGIN CONTEXT HELPERS([\s\S]*?)\/\/ END CONTEXT HELPERS/);
  assert.ok(m, 'helperblok niet gevonden in index.html');
  ctx = vm.createContext({});
  vm.runInContext(m[1], ctx);
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
  it('activeContext wordt nergens anders dan in de helpers gewijzigd (blijft LEGACY)', () => {
    const outside = html.replace(/\/\/ BEGIN CONTEXT HELPERS[\s\S]*?\/\/ END CONTEXT HELPERS/, '');
    assert.strictEqual((outside.match(/activeContext\s*=[^=]/g) || []).length, 0);
  });
});
