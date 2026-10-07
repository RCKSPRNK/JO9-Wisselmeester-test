'use strict';
// Tests voor "Mijn teams" (Fase 2C-1 + 2C-2): zuivere logica uit index.html.
// Laadt de blokken CONTEXT HELPERS, CONTEXT STATE en TEAM PICKER LOGIC in een geisoleerde VM.
// Geen browser, geen netwerk, geen Firebase.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');
const { describe, it, before } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const alerts = [];
let ctx;
const run = code => vm.runInContext(code, ctx);
const block = (name) => {
  const m = html.match(new RegExp('// BEGIN ' + name + '([\\s\\S]*?)// END ' + name));
  assert.ok(m, 'blok niet gevonden: ' + name);
  return m[1];
};

// Eenvoudige opslag die zich gedraagt als localStorage.
const mkStorage = (init = {}, opts = {}) => {
  const data = { ...init };
  return {
    data,
    getItem: k => { if (opts.throwGet) throw new Error('nope'); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: (k, v) => { if (opts.throwSet) throw new Error('quota'); data[k] = String(v); },
    removeItem: k => { delete data[k]; }
  };
};

before(() => {
  ctx = vm.createContext({ console: { warn() {}, info() {}, log() {}, error() {} }, alert(msg) { alerts.push(String(msg)); } });
  vm.runInContext(block('CONTEXT HELPERS'), ctx);
  vm.runInContext(block('CONTEXT STATE'), ctx);
  vm.runInContext(block('TEAM PICKER LOGIC'), ctx);
  ctx.mkStorage = mkStorage;
});

describe('Pref-validatie: jo9_active_team_{uid}', () => {
  it('sleutel is per uid', () => {
    assert.strictEqual(run('activeTeamPrefKey("uidA")'), 'jo9_active_team_uidA');
    assert.notStrictEqual(run('activeTeamPrefKey("uidA")'), run('activeTeamPrefKey("uidB")'));
  });
  it('ongeldige uid geeft een fout bij de sleutel en null bij lezen', () => {
    for (const bad of ['""', '"a/b"', '"../x"', 'null', 'undefined', '42', '"x".repeat(129)']) {
      assert.throws(() => run(`activeTeamPrefKey(${bad})`), /uid/, bad);
      assert.strictEqual(run(`readActiveTeamPref(${bad}, mkStorage())`), null, bad);
    }
  });
  it('geldige voorkeur wordt gelezen; ontbrekende geeft null', () => {
    ctx.st = mkStorage({ jo9_active_team_u1: 'testteam2b' });
    assert.strictEqual(run('readActiveTeamPref("u1", st)'), 'testteam2b');
    assert.strictEqual(run('readActiveTeamPref("u2", st)'), null);
  });
  it('ongeldige of gemanipuleerde waarden worden genegeerd EN opgeruimd', () => {
    for (const bad of ['', '../x', 'a/b', 'a.b', 'x'.repeat(65), ' team', 'team\n']) {
      ctx.st = mkStorage({ jo9_active_team_u1: bad });
      assert.strictEqual(run('readActiveTeamPref("u1", st)'), null, JSON.stringify(bad));
      assert.strictEqual(Object.prototype.hasOwnProperty.call(ctx.st.data, 'jo9_active_team_u1'), false, 'niet opgeruimd: ' + JSON.stringify(bad));
    }
  });
  it('lezen faalt veilig als opslag een fout gooit (geen exception, geen verwijdering)', () => {
    ctx.st = mkStorage({ jo9_active_team_u1: 'teamA' }, { throwGet: true });
    assert.strictEqual(run('readActiveTeamPref("u1", st)'), null);
    assert.strictEqual(ctx.st.data.jo9_active_team_u1, 'teamA');
  });
  it('schrijven: alleen geldig teamId; opslagfout geeft false, geen exception', () => {
    ctx.st = mkStorage();
    assert.strictEqual(run('writeActiveTeamPref("u1", "teamA", st)'), true);
    assert.strictEqual(ctx.st.data.jo9_active_team_u1, 'teamA');
    for (const bad of ['""', '"../x"', '"a/b"', 'null', 'undefined', '5']) {
      assert.throws(() => run(`writeActiveTeamPref("u1", ${bad}, st)`), /Ongeldig/, bad);
    }
    assert.strictEqual(ctx.st.data.jo9_active_team_u1, 'teamA');
    ctx.st2 = mkStorage({}, { throwSet: true });
    assert.strictEqual(run('writeActiveTeamPref("u1", "teamA", st2)'), false);
  });
  it('wissen verwijdert alleen de sleutel van dat account', () => {
    ctx.st = mkStorage({ jo9_active_team_u1: 'teamA', jo9_active_team_u2: 'teamB', jo9_players: '[]' });
    run('clearActiveTeamPref("u1", st)');
    assert.deepStrictEqual(Object.keys(ctx.st.data).sort(), ['jo9_active_team_u2', 'jo9_players']);
    run('clearActiveTeamPref("../x", st)');
    assert.strictEqual(Object.keys(ctx.st.data).length, 2);
  });
  it('de voorkeur-sleutel botst niet met de bestaande data-sleutels', () => {
    for (const k of ['players', 'matches', 'match_counter', 'storage_version']) {
      assert.ok(!run(`storageKey("${k}")`).startsWith('jo9_active_team_'));
    }
  });
});

describe('parseTeamIndex: users/{uid}/teams is alleen een index', () => {
  it('leeg of ongeldig geeft []', () => {
    for (const v of ['null', 'undefined', '"x"', '5', 'true', '{}']) assert.deepStrictEqual(JSON.parse(run(`JSON.stringify(parseTeamIndex(${v}))`)), [], v);
  });
  it('alleen waarde true en geldig teamId; gesorteerd', () => {
    const r = JSON.parse(run('JSON.stringify(parseTeamIndex({b:true, a:true, c:false, d:"owner", "../x":true, "a/b":true, e:1, "-Nz_1":true}))'));
    assert.deepStrictEqual(r, ['-Nz_1', 'a', 'b']);
  });
  it('begrensd op MAX_TEAMS_LISTED', () => {
    const r = JSON.parse(run('(() => { const o = {}; for (let i = 0; i < 50; i++) o["t" + String(i).padStart(2, "0")] = true; return JSON.stringify(parseTeamIndex(o)); })()'));
    assert.strictEqual(r.length, 20);
  });
});

describe('classifyTeamMeta: stale index en tijdelijke fouten', () => {
  const ok = v => ({ status: 'fulfilled', value: v });
  const denied = () => ({ status: 'rejected', reason: { code: 'PERMISSION_DENIED', message: 'permission_denied' } });
  const net = () => ({ status: 'rejected', reason: new Error('Client is offline') });
  const cls = arr => { ctx.arr = arr; return JSON.parse(run('JSON.stringify(classifyTeamMeta("t1", arr))')); };

  it('alle reads gelukt: available met getrimde metadata', () => {
    const r = cls([ok(' Club A '), ok('Alfa'), ok('2026-2027')]);
    assert.deepStrictEqual(r, { id: 't1', status: 'available', clubName: 'Club A', teamName: 'Alfa', season: '2026-2027' });
  });
  it('niet-tekst of ontbrekende waarden worden lege tekst (geen crash)', () => {
    const r = cls([ok(null), ok(5), ok({ x: 1 })]);
    assert.strictEqual(r.status, 'available');
    assert.deepStrictEqual([r.clubName, r.teamName, r.season], ['', '', '']);
  });
  it('alle reads PERMISSION_DENIED (team weg of geen lid): unavailable', () => {
    assert.strictEqual(cls([denied(), denied(), denied()]).status, 'unavailable');
    assert.strictEqual(cls([ok('x'), denied(), ok('y')]).status, 'unavailable');
  });
  it('netwerkfout: error (niet definitief)', () => {
    assert.strictEqual(cls([net(), net(), net()]).status, 'error');
  });
  it('gemengd denied + netwerkfout: error (voorzichtig, voorkeur blijft)', () => {
    assert.strictEqual(cls([denied(), net(), denied()]).status, 'error');
  });
  it('PERMISSION_DENIED wordt ook herkend aan de foutmelding', () => {
    const r = cls([{ status: 'rejected', reason: new Error('permission_denied at /teams/x') }, denied(), denied()]);
    assert.strictEqual(r.status, 'unavailable');
  });
});

describe('teamLabel en sortTeams', () => {
  it('label: club en team; terugval op id', () => {
    assert.strictEqual(run('teamLabel({id:"t", clubName:"Club", teamName:"JO9"})'), 'Club · JO9');
    assert.strictEqual(run('teamLabel({id:"t", clubName:"", teamName:"JO9"})'), 'JO9');
    assert.strictEqual(run('teamLabel({id:"t1", clubName:"", teamName:""})'), 't1');
  });
  it('beschikbaar eerst, dan error, dan niet beschikbaar; daarbinnen alfabetisch', () => {
    const r = JSON.parse(run(`JSON.stringify(sortTeams([
      {id:"u", status:"unavailable", clubName:"", teamName:""},
      {id:"b", status:"available", clubName:"B", teamName:"x"},
      {id:"e", status:"error", clubName:"", teamName:""},
      {id:"a", status:"available", clubName:"A", teamName:"x"}]).map(t => t.id))`));
    assert.deepStrictEqual(r, ['a', 'b', 'e', 'u']);
  });
});

describe('decideRestore: G1 (optie B)', () => {
  const d = (pref, listOk, teams) => { ctx.inp = { pref, listOk, teams }; return JSON.parse(run('JSON.stringify(decideRestore(inp))')); };
  const T = (id, status) => ({ id, status });

  it('geen voorkeur: legacy, niets wissen, geen melding', () => {
    assert.deepStrictEqual(d(null, true, []), { action: 'legacy', teamId: null, clearPref: false, notice: null, retry: false });
  });
  it('voorkeur + beschikbaar team: teamsync', () => {
    assert.deepStrictEqual(d('teamA', true, [T('teamA', 'available'), T('teamB', 'available')]), { action: 'team', teamId: 'teamA', clearPref: false, notice: null, retry: false });
  });
  it('voorkeur niet (meer) in de lijst: wissen + legacy + melding', () => {
    assert.deepStrictEqual(d('teamZ', true, [T('teamA', 'available')]), { action: 'legacy', teamId: null, clearPref: true, notice: 'team-not-in-list', retry: false });
    assert.deepStrictEqual(d('teamZ', true, []), { action: 'legacy', teamId: null, clearPref: true, notice: 'team-not-in-list', retry: false });
  });
  it('voorkeur in de lijst maar niet beschikbaar (geen lid / team weg): wissen + legacy', () => {
    assert.deepStrictEqual(d('teamA', true, [T('teamA', 'unavailable')]), { action: 'legacy', teamId: null, clearPref: true, notice: 'team-unavailable', retry: false });
  });
  it('tijdelijke fout bij de lijst: voorkeur BEHOUDEN, tijdelijk legacy, opnieuw proberen', () => {
    assert.deepStrictEqual(d('teamA', false, []), { action: 'legacy', teamId: null, clearPref: false, notice: 'temporary-error', retry: true });
  });
  it('tijdelijke fout bij de metadata van het team: voorkeur BEHOUDEN, opnieuw proberen', () => {
    assert.deepStrictEqual(d('teamA', true, [T('teamA', 'error')]), { action: 'legacy', teamId: null, clearPref: false, notice: 'temporary-error', retry: true });
  });
  it('ongeldige voorkeur: legacy en wissen', () => {
    for (const bad of ['../x', 'a/b']) assert.deepStrictEqual(d(bad, true, [T('teamA', 'available')]), { action: 'legacy', teamId: null, clearPref: true, notice: null, retry: false });
  });
  it('INVARIANT: bij een tijdelijke fout wordt de voorkeur nooit gewist; bij action team ook niet', () => {
    const statuses = ['available', 'unavailable', 'error', null];
    for (const listOk of [true, false]) for (const st of statuses) {
      const teams = st ? [T('teamA', st)] : [];
      const r = d('teamA', listOk, teams);
      if (!listOk || st === 'error') assert.strictEqual(r.clearPref, false, `listOk=${listOk} st=${st}`);
      if (r.action === 'team') assert.strictEqual(r.clearPref, false);
      // clearPref alleen bij definitieve uitkomst
      if (r.clearPref) assert.ok(listOk && (st === 'unavailable' || st === null));
    }
  });
});

describe('Schrijfpoort tijdens het herstellen van een voorkeur', () => {
  it('canWrite: legacy is geblokkeerd zolang restorePending true is, en daarna weer vrij', () => {
    run('restorePending = false; activeContext = LEGACY_CONTEXT');
    assert.strictEqual(run('canWrite()'), true);
    run('restorePending = true');
    assert.strictEqual(run('canWrite()'), false);
    run('restorePending = false');
    assert.strictEqual(run('canWrite()'), true);
  });
  it('canWrite: in teammodus bepaalt alleen syncReady (restorePending doet er niet toe)', () => {
    run('activeContext = {mode:"team", teamId:"t1"}; syncReady = true; restorePending = true');
    try { assert.strictEqual(run('canWrite()'), true); } finally { run('activeContext = LEGACY_CONTEXT; syncReady = false; restorePending = false'); }
  });
  it('assertWritable: legacy tijdens restore geeft false + melding', () => {
    alerts.length = 0;
    run('restorePending = true');
    try {
      assert.strictEqual(run('assertWritable("test")'), false);
      assert.strictEqual(alerts.length, 1);
    } finally { run('restorePending = false'); }
  });
});

describe('Statische controles op index.html (2C-1)', () => {
  const ui = html.slice(html.indexOf('// MIJN TEAMS (Fase 2C-1)'), html.indexOf('// AUTH-STATUS (centraal)'));
  it('het UI-blok is gevonden', () => assert.ok(ui.length > 2000));
  it('Mijn teams schrijft alleen via createTeam: één atomische update, geen set/remove', () => {
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/\b(set|remove)\(\s*ref\(/.test(code));
    assert.ok(!/saveMatchesToFirebase|savePlayersToFirebase/.test(code));
    assert.strictEqual((code.match(/\bupdate\(/g) || []).length, 1);
    assert.strictEqual((code.match(/\bpush\(/g) || []).length, 1);
    assert.ok(/push\(ref\(db, "teams"\)\)\.key/.test(code));
    assert.ok(/get\(ref\(db, "teams\/"/.test(ui));
  });
  it('alleen de drie metadata-velden worden gelezen (geen players/matches/members)', () => {
    assert.ok(/\["clubName", "teamName", "season"\]/.test(ui));
    assert.ok(!/teams\/" \+ teamId \+ "\/(players|matches|members)/.test(ui));
  });
  it('teamnamen worden als tekst gerenderd (geen innerHTML)', () => {
    assert.ok(!/innerHTML/.test(ui));
    assert.ok(/textContent = teamLabel\(team\)/.test(ui));
  });
  it('teamselectie gebruikt dezelfde setActiveContext en geen dev-wrapper', () => {
    assert.ok(/setActiveContext\(\{ mode: "team", teamId: team\.id \}\)/.test(ui));
    assert.ok(!/jo9Firebase\.setActiveContext/.test(ui));
  });
  it('de tijdelijke ontwikkelaarsfunctie blijft bestaan', () => {
    assert.ok(/window\.jo9Firebase\.setActiveContext = function \(context\)/.test(html));
  });
  it('legacy-sync wacht op restorePending (ensureSync) en de handler bepaalt de voorkeur eerst', () => {
    assert.ok(/if \(restorePending && activeContext\.mode === "legacy"\) \{\s*return;\s*\}/.test(html));
    const h = html.slice(html.indexOf('onAuthStateChanged(auth, user => {'));
    assert.ok(h.indexOf('onVerifiedAccount(user)') > -1 && h.indexOf('onVerifiedAccount(user)') < h.indexOf('setActiveContext(LEGACY_CONTEXT)'));
    assert.ok(h.indexOf('onVerifiedAccount(user)') < h.lastIndexOf('ensureSync();'));
  });
  it('de voorkeur wordt alleen gewist bij een definitieve uitkomst (denied of decideRestore)', () => {
    const clears = ui.match(/clearActiveTeamPref\(/g) || [];
    assert.strictEqual(clears.length, 2);
    assert.ok(/if \(decision\.clearPref\) \{\s*clearActiveTeamPref\(uid\);/.test(ui));
    assert.ok(/contextPhase === "denied" && gen === contextGeneration && uid\) \{\s*clearActiveTeamPref\(uid\);/.test(ui));
  });
  it('setActiveContext zelf is onaangeroerd: geen opslag van de keuze erin', () => {
    const sw = block('CONTEXT SWITCH');
    assert.ok(!/localStorage|writeActiveTeamPref/.test(sw));
  });
  it('de voorkeur-sleutel komt via een constante en niet als losse literal buiten het logica-blok', () => {
    const outside = html
      .replace(/\/\/ BEGIN TEAM PICKER LOGIC[\s\S]*?\/\/ END TEAM PICKER LOGIC/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.strictEqual((outside.match(/jo9_active_team_/g) || []).length, 0);
  });
});

describe('2C-2: buildNewTeamRecord (zuivere logica)', () => {
  const ok3 = { clubName: 'TEST Club', teamName: 'JO9-1', season: '2026-2027' };

  it('record: precies de zes velden; aanmaker is enige owner; geen legacy-data', () => {
    ctx.v = ok3;
    const r = JSON.parse(run('JSON.stringify(buildNewTeamRecord("uidA", v, 1700000000000))'));
    assert.deepStrictEqual(Object.keys(r).sort(), ['clubName', 'createdAt', 'createdBy', 'members', 'season', 'teamName']);
    assert.strictEqual(r.createdBy, 'uidA');
    assert.strictEqual(r.createdAt, 1700000000000);
    assert.deepStrictEqual(r.members, { uidA: 'owner' });
    assert.ok(!('players' in r) && !('matches' in r));
  });

  it('record: ongeldige uid geeft een fout', () => {
    ctx.v = ok3;
    for (const bad of ['""', '"a/b"', '"../x"', 'null', 'undefined', '"x".repeat(129)', '42']) {
      assert.throws(() => run('buildNewTeamRecord(' + bad + ', v, 1)'), /uid/, bad);
    }
  });
});

describe('2C-2: classifyCreateError (zuivere logica)', () => {
  it('permission-denied is definitief; al het andere is onzeker', () => {
    for (const e of ['{code:"PERMISSION_DENIED"}', '{code:"permission-denied"}']) {
      assert.strictEqual(run('classifyCreateError(' + e + ')'), 'denied', e);
    }
    for (const e of ['new Error("offline")', '{code:"timeout"}', 'null', 'undefined', '"boom"', '{code:"ABORTED"}']) {
      assert.strictEqual(run('classifyCreateError(' + e + ')'), 'transient', e);
    }
  });
});

describe('2C-2: statische controles op createTeam', () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const start = html.indexOf('async function createTeam()');
  const end = html.indexOf('function renderTeams()');
  const create = strip(html.slice(start, end));
  const wstart = html.indexOf('async function writeNewTeam');
  const write = strip(html.slice(wstart, start));

  it('createTeam is gevonden', () => assert.ok(start > 0 && end > start && create.length > 500));
  it('dubbele submit voorkomen: creatingTeam guard + createGen token', () => {
    assert.ok(/if \(creatingTeam \|\| restorePending\)/.test(create));
    assert.ok(/const token = \+\+createGen;/.test(create));
    assert.ok(/if \(token === createGen\)/.test(create));
  });
  it('teamId van push().key, niet afhankelijk van namen', () => {
    assert.ok(/push\(ref\(db, "teams"\)\)\.key/.test(create));
    assert.ok(/isValidTeamId\(newId\)/.test(create));
  });
  it('één atomische update: teams/{id} + users/{uid}/teams/{id}', () => {
    assert.strictEqual((write.match(/update\(ref\(db\), updates\)/g) || []).length, 1);
    assert.ok(/updates\["teams\/" \+ pending\.teamId\] = pending\.record;/.test(write));
    assert.ok(/updates\["users\/" \+ pending\.uid \+ "\/teams\/" \+ pending\.teamId\] = true;/.test(write));
    assert.strictEqual((write.match(/updates\[/g) || []).length, 2);
  });
  it('geen legacy-data, geen spelers/matches kopiëren', () => {
    const all = create + write;
    assert.ok(!/savePlayersToFirebase|saveMatchesToFirebase/.test(all));
    assert.ok(!/DEFAULT_PLAYERS/.test(all));
  });
  it('volgorde: check-exists → write → readback → lijst → selectTeam', () => {
    const ir1 = create.indexOf('await readTeamMeta');
    const iw = create.indexOf('await writeNewTeam');
    const ir2 = create.indexOf('await readTeamMeta', iw);
    const il = create.indexOf('await refreshTeams');
    const iss = create.indexOf('selectTeam(teamId)');
    assert.ok(ir1 > 0 && iw > ir1 && ir2 > iw && il > ir2 && iss > il);
  });
  it('stale-check na elke await', () => {
    const awaits = (create.match(/\bawait\b/g) || []).length;
    const checks = (create.match(/if \(stale\(\)\)/g) || []).length;
    assert.strictEqual(awaits, 4);
    assert.strictEqual(checks, awaits);
  });
  it('niet-definitieve fout: hergebruik pendingCreate', () => {
    assert.ok(/pending\.uid === uid/.test(create));
    assert.ok(/JSON\.stringify\(pending\.values\)/.test(create));
  });
  it('definitieve fout (denied): pendingCreate wordt gewist', () => {
    assert.ok(/classifyCreateError\(error\) === "denied"/.test(create));
  });
  it('knoppen en velden uitgeschakeld tijdens aanmaak', () => {
    assert.ok(/authEl\("teamCreateSubmit"\)\.disabled = creatingTeam/.test(html));
    assert.ok(/teamsCreateToggle"\)\.disabled = restorePending \|\| creatingTeam/.test(html));
    assert.ok(/refresh\.disabled = restorePending \|\| creatingTeam/.test(html));
    assert.ok(/authEl\("teamCreateCancel"\)\.disabled = creatingTeam/.test(html));
    assert.ok(/authEl\(id\)\.disabled = creatingTeam/.test(html));
  });
  it('resetCreateState bij uitloggen en accountwissel', () => {
    assert.ok(/resetCreateState\(\);/.test(html));
    assert.ok(/teamsState\.uid !== null && teamsState\.uid !== uid/.test(html));
    assert.ok(/createGen\+\+;/.test(html));
  });
  it('HTML-elementen binnen teamsCard', () => {
    const card = html.slice(html.indexOf('id="teamsCard"'), html.indexOf('1. Nieuwe wedstrijd'));
    for (const id of ['teamsCreateToggle', 'teamCreateForm', 'teamCreateMessage', 'teamCreateClub', 'teamCreateName', 'teamCreateSeason', 'teamCreateSubmit', 'teamCreateCancel', 'teamsRefresh']) {
      assert.ok(card.includes('id="' + id + '"'), id);
    }
  });
});
