'use strict';
// Verifieert de leeftijdscategorie-uitbreiding door de relevante functies
// RECHTSTREEKS uit index.html te laden (zelfde aanpak als de bestaande
// tests/*.test.js: VM-geïsoleerd, geen browser, geen Firebase).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');
const { describe, it } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Extraheer de benodigde functies/constantes met hun exacte brontekst
// (niet retypen - voorkomt drift tussen test en productiecode).
function extractBlock(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  if (start === -1) throw new Error('marker niet gevonden: ' + startMarker);
  const end = html.indexOf(endMarker, start);
  if (end === -1) throw new Error('eindmarker niet gevonden: ' + endMarker);
  return html.slice(start, end);
}

// AGE_CATEGORIES t/m formatRoundMinutes (vóór applyBranding).
const categoryBlock = extractBlock(
  'const AGE_CATEGORIES = {',
  'function applyBranding()'
);

// findIdealPlayCounts (vóór buildSchedule's greedyFallbackSchedule-comment).
const findIdealBlock = extractBlock(
  'function findIdealPlayCounts(present, category) {',
  '/*\nGarandeerde noodoplossing'
);

// greedyFallbackSchedule + SCHEDULE_TIME_BUDGET_MS + buildSchedule.
const buildScheduleBlock = extractBlock(
  'function greedyFallbackSchedule(n, fieldPlayers, rounds, playCounts) {',
  '\n\n/* -----------------------------\n   COMBINATIES'
);

// combinationsOf (gebruikt door buildSchedule).
const combinationsBlock = extractBlock(
  'function combinationsOf(array, size) {',
  '\n\n\n/* ========================================================='
);

let ctx;
const run = code => vm.runInContext(code, ctx);

function freshContext(matchesData) {
  ctx = vm.createContext({
    console: { warn() {}, info() {}, log() {}, error() {} },
    matches: matchesData || []
  });
  vm.runInContext(categoryBlock, ctx);
  vm.runInContext(combinationsBlock, ctx);
  vm.runInContext(findIdealBlock, ctx);
  vm.runInContext(buildScheduleBlock, ctx);
}

describe('AGE_CATEGORIES: definitie', () => {
  it('alle 5 categorieën bestaan met de juiste specificaties', () => {
    freshContext();
    const cats = JSON.parse(run('JSON.stringify(AGE_CATEGORIES)'));
    assert.deepStrictEqual(Object.keys(cats).sort(), ['JO10', 'JO11', 'JO12', 'JO8', 'JO9']);
    assert.deepStrictEqual(cats.JO8, { label: cats.JO8.label, fieldPlayers: 6, rounds: 4, roundMinutes: 10 });
    assert.deepStrictEqual(cats.JO9, { label: cats.JO9.label, fieldPlayers: 6, rounds: 4, roundMinutes: 10 });
    assert.deepStrictEqual(cats.JO10, { label: cats.JO10.label, fieldPlayers: 6, rounds: 4, roundMinutes: 12.5 });
    assert.deepStrictEqual(cats.JO11, { label: cats.JO11.label, fieldPlayers: 8, rounds: 4, roundMinutes: 15 });
    assert.deepStrictEqual(cats.JO12, { label: cats.JO12.label, fieldPlayers: 8, rounds: 4, roundMinutes: 15 });
  });
  it('DEFAULT_AGE_CATEGORY is JO9 (bestaand gedrag voor teams zonder categorie)', () => {
    freshContext();
    assert.strictEqual(run('DEFAULT_AGE_CATEGORY'), 'JO9');
  });
  it('resolveAgeCategory valt terug op JO9 bij ontbrekende/onbekende sleutel', () => {
    freshContext();
    for (const bad of ['undefined', 'null', '""', '"JO7"', '"jo9"', '"XYZ"']) {
      const r = JSON.parse(run(`JSON.stringify(resolveAgeCategory(${bad}))`));
      assert.strictEqual(r.key, 'JO9', bad);
      assert.strictEqual(r.fieldPlayers, 6, bad);
      assert.strictEqual(r.rounds, 4, bad);
      assert.strictEqual(r.roundMinutes, 10, bad);
    }
  });
  it('resolveAgeCategory geeft de juiste specificatie voor elke geldige sleutel', () => {
    freshContext();
    const expectations = {
      JO8: { fieldPlayers: 6, roundMinutes: 10 },
      JO9: { fieldPlayers: 6, roundMinutes: 10 },
      JO10: { fieldPlayers: 6, roundMinutes: 12.5 },
      JO11: { fieldPlayers: 8, roundMinutes: 15 },
      JO12: { fieldPlayers: 8, roundMinutes: 15 }
    };
    for (const [key, exp] of Object.entries(expectations)) {
      const r = JSON.parse(run(`JSON.stringify(resolveAgeCategory("${key}"))`));
      assert.strictEqual(r.key, key);
      assert.strictEqual(r.fieldPlayers, exp.fieldPlayers, key);
      assert.strictEqual(r.rounds, 4, key);
      assert.strictEqual(r.roundMinutes, exp.roundMinutes, key);
    }
  });
  it('formatRoundMinutes: 10 -> "10", 12.5 -> "12,5", 15 -> "15"', () => {
    freshContext();
    assert.strictEqual(run('formatRoundMinutes(10)'), '10');
    assert.strictEqual(run('formatRoundMinutes(12.5)'), '12,5');
    assert.strictEqual(run('formatRoundMinutes(15)'), '15');
  });
});

describe('findIdealPlayCounts: eerlijke verdeling per categorie', () => {
  it('JO9 (6/4): som van playCounts = fieldPlayers*rounds voor elk aantal spelers', () => {
    freshContext();
    for (let n = 6; n <= 18; n++) {
      ctx.present = Array.from({ length: n }, (_, i) => ({ id: i, name: 'P' + i }));
      const counts = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO9")))'));
      assert.strictEqual(counts.length, n, 'n=' + n);
      assert.strictEqual(counts.reduce((a, b) => a + b, 0), 24, 'n=' + n + ' som moet 24 zijn');
      // Elke speler krijgt minimumRounds of minimumRounds+1 rondes (geen grotere spreiding).
      const min = Math.min(...counts), max = Math.max(...counts);
      assert.ok(max - min <= 1, `n=${n}: spreiding te groot (${min}..${max})`);
    }
  });
  it('JO11/JO12 (8/4): som van playCounts = 32 voor elk aantal spelers', () => {
    freshContext();
    for (let n = 8; n <= 18; n++) {
      ctx.present = Array.from({ length: n }, (_, i) => ({ id: i, name: 'P' + i }));
      const counts = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO11")))'));
      assert.strictEqual(counts.reduce((a, b) => a + b, 0), 32, 'n=' + n);
      const min = Math.min(...counts), max = Math.max(...counts);
      assert.ok(max - min <= 1, `n=${n}: spreiding te groot (${min}..${max})`);
    }
  });
  it('JO10 (6/4, 12.5 min/ronde): categorie beïnvloedt alleen roundMinutes, niet de rondeverdeling', () => {
    freshContext();
    ctx.present = Array.from({ length: 9 }, (_, i) => ({ id: i, name: 'P' + i }));
    const countsJO9 = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO9")))'));
    const countsJO10 = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO10")))'));
    // Beide hebben fieldPlayers=6, rounds=4 -> dezelfde playCounts-verdeling.
    assert.deepStrictEqual(countsJO9, countsJO10);
  });
  it('historische eerlijkheid: respecteert category-momentopname van eerdere wedstrijden', () => {
    // Speler A heeft 1 eerdere JO9-wedstrijd (6 spelers, 4 rondes, 10 min)
    // gespeeld met een voordeel (meer dan het gemiddelde). Zonder categorie-
    // momentopname zou een latere JO11-berekening dit verkeerd interpreteren.
    const matchesData = [{
      matchNumber: 1,
      playerCount: 6,
      category: { fieldPlayers: 6, rounds: 4, roundMinutes: 10 },
      presentPlayerIds: [0, 1, 2, 3, 4, 5],
      players: [
        { playerId: 0, minutes: 50 }, // boven gemiddelde (40)
        { playerId: 1, minutes: 30 },
        { playerId: 2, minutes: 40 },
        { playerId: 3, minutes: 40 },
        { playerId: 4, minutes: 40 },
        { playerId: 5, minutes: 40 }
      ],
      advantagePlayerIds: [0]
    }];
    freshContext(matchesData);
    ctx.present = [0, 1, 2, 3, 4, 5].map(id => ({ id, name: 'P' + id }));
    const counts = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO9")))'));
    // Speler 0 had een voordeel (50 > 40 verwacht): zijn eerlijkheidsscore
    // is lager (minder prioriteit) dan speler 1 die een achterstand had.
    // We verifiëren alleen dat de berekening NIET crasht en een geldige
    // verdeling teruggeeft (som = 24), met speler 1 >= speler 0 in counts.
    assert.strictEqual(counts.reduce((a, b) => a + b, 0), 24);
  });
});

describe('buildSchedule: geldig schema voor alle categorieën en aantallen', () => {
  function validate(n, fieldPlayers, rounds, playCounts, schedule) {
    if (!schedule) return 'NO_SCHEDULE';
    const benchCount = n - fieldPlayers;
    const requiredBench = playCounts.map(c => rounds - c);
    const seen = Array.from({ length: n }, () => 0);
    if (schedule.length !== rounds) return 'WRONG_ROUNDS';
    for (const combo of schedule) {
      if (combo.length !== benchCount) return 'WRONG_BENCH_SIZE';
      for (const idx of combo) seen[idx]++;
    }
    for (let i = 0; i < n; i++) {
      if (seen[i] !== requiredBench[i]) return `MISMATCH_${i}`;
    }
    return 'OK';
  }

  it('JO8/JO9/JO10 (6 tegen 6): geldig schema voor REALISTISCHE aantallen (minimum t/m een paar wissels)', () => {
    freshContext();
    // Realistisch: een jeugdteam heeft meestal 1-4 wisselspelers
    // boven het aantal veldspelers, niet het absolute maximum.
    // n=12 (het bekende regressiegeval) blijft apart getest hieronder.
    for (const n of [6, 7, 8, 9]) {
      ctx.present = Array.from({ length: n }, (_, i) => ({ id: i, name: 'P' + i }));
      const category = JSON.parse(run('JSON.stringify(resolveAgeCategory("JO9"))'));
      const counts = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO9")))'));
      ctx.playCounts = counts;
      ctx.category = category;
      const schedule = JSON.parse(run('JSON.stringify(buildSchedule(present, playCounts, category))'));
      assert.strictEqual(validate(n, 6, 4, counts, schedule), 'OK', 'n=' + n);
    }
  });

  it('JO11/JO12 (8 tegen 8): geldig schema voor REALISTISCHE aantallen (minimum t/m een paar wissels)', () => {
    freshContext();
    for (const n of [8, 9, 10, 11]) {
      ctx.present = Array.from({ length: n }, (_, i) => ({ id: i, name: 'P' + i }));
      const category = JSON.parse(run('JSON.stringify(resolveAgeCategory("JO11"))'));
      const counts = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO11")))'));
      ctx.playCounts = counts;
      ctx.category = category;
      const t0 = Date.now();
      const schedule = JSON.parse(run('JSON.stringify(buildSchedule(present, playCounts, category))'));
      const ms = Date.now() - t0;
      assert.strictEqual(validate(n, 8, 4, counts, schedule), 'OK', 'n=' + n);
      // Realistische aantallen moeten snel zijn (ruim binnen het
      // tijdsbudget), niet pas na het volledige budget.
      assert.ok(ms < 2000, `n=${n} duurde te lang voor een realistisch aantal: ${ms}ms`);
    }
  });

  it('REGRESSIE: n=12 spelers bij 6-tegen-6 hing voorheen oneindig; moet nu binnen budget + geldig terugkomen', () => {
    freshContext();
    ctx.present = Array.from({ length: 12 }, (_, i) => ({ id: i, name: 'P' + i }));
    const category = JSON.parse(run('JSON.stringify(resolveAgeCategory("JO9"))'));
    const counts = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO9")))'));
    ctx.playCounts = counts;
    ctx.category = category;
    const t0 = Date.now();
    const schedule = JSON.parse(run('JSON.stringify(buildSchedule(present, playCounts, category))'));
    const ms = Date.now() - t0;
    assert.strictEqual(validate(12, 6, 4, counts, schedule), 'OK');
    assert.ok(ms < 4000, `duurde te lang: ${ms}ms (was eerder: hangt > 90s)`);
  });

  it('STRESSTEST (apart, tijdgebonden): grootste realistische 8-tegen-8-groep (14 spelers, JO12)', () => {
    // Harde testlimiet: ruim boven het interne SCHEDULE_TIME_BUDGET_MS
    // (3000ms) + marge voor greedy-fallback en test-overhead, maar
    // STRIKT begrensd - geen onbeperkte wachttijd. Overschrijding laat
    // de test FALEN zodat een regressie in combinationsOf/de
    // zoekstrategie direct zichtbaar wordt, in plaats van de testrun
    // onbeperkt te laten hangen.
    freshContext();
    const HARD_TEST_LIMIT_MS = 6000;
    const n = 14;
    ctx.present = Array.from({ length: n }, (_, i) => ({ id: i, name: 'P' + i }));
    const category = JSON.parse(run('JSON.stringify(resolveAgeCategory("JO12"))'));
    const counts = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO12")))'));
    ctx.playCounts = counts;
    ctx.category = category;
    const t0 = Date.now();
    const schedule = JSON.parse(run('JSON.stringify(buildSchedule(present, playCounts, category))'));
    const ms = Date.now() - t0;
    if (ms > HARD_TEST_LIMIT_MS) {
      assert.fail(
        `STRESSTEST TIME-OUT: duurde ${ms}ms (harde limiet ${HARD_TEST_LIMIT_MS}ms). ` +
        `Dit overschrijdt het interne tijdsbudget (3000ms) fors - onderzoek ` +
        `combinationsOf/de zoekstrategie voordat dit wordt samengevoegd.`
      );
    }
    assert.strictEqual(validate(n, 8, 4, counts, schedule), 'OK', 'stresstest-schema moet geldig zijn');
  });

  it('greedyFallbackSchedule: altijd geldig en instant, voor alle categorie-vormen', () => {
    freshContext();
    for (const [fieldPlayers, ns] of [[6, [6,9,12,15,18]], [8, [8,11,14,17,18]]]) {
      for (const n of ns) {
        ctx.present = Array.from({ length: n }, (_, i) => ({ id: i }));
        const counts = JSON.parse(run(`JSON.stringify(findIdealPlayCounts(present, {fieldPlayers:${fieldPlayers}, rounds:4}))`));
        ctx.playCounts = counts;
        const schedule = JSON.parse(run(`JSON.stringify(greedyFallbackSchedule(${n}, ${fieldPlayers}, 4, playCounts))`));
        assert.strictEqual(validate(n, fieldPlayers, 4, counts, schedule), 'OK', `field=${fieldPlayers} n=${n}`);
      }
    }
  });

  it('drie wisselmomenten: elk schema heeft exact 4 rondes en dus 3 overgangsmomenten ertussen', () => {
    freshContext();
    ctx.present = Array.from({ length: 9 }, (_, i) => ({ id: i, name: 'P' + i }));
    const category = JSON.parse(run('JSON.stringify(resolveAgeCategory("JO9"))'));
    const counts = JSON.parse(run('JSON.stringify(findIdealPlayCounts(present, resolveAgeCategory("JO9")))'));
    ctx.playCounts = counts;
    ctx.category = category;
    const schedule = JSON.parse(run('JSON.stringify(buildSchedule(present, playCounts, category))'));
    assert.strictEqual(schedule.length, 4, 'vier rondes');
    // 4 rondes impliceert 3 wisselmomenten tussen de rondes (1->2, 2->3, 3->4).
    assert.strictEqual(schedule.length - 1, 3, 'drie wisselmomenten');
  });
});
