'use strict';
/*
 * ==========================================================================
 * Wisselmeester - Fase 2C-3: "Trainer uitnodigen" (Cloud Functions)
 * ==========================================================================
 *
 * DE ENIGE plaats waar:
 *   - inviteCodes worden aangemaakt/gemaakt/verstoken, en
 *   - trainer‑leden worden toegevoegd aan een team.
 *
 * Waarom een Function (Admin SDK) en geen client‑write:
 *   - inviteCodes is in de RTDB Rules volledig admin‑only (.read/.write:false;
 *     rules.test.js tests 28, 29).  Clients mogen de boom NIET lezen/schrijven.
 *   - members/{uid} mag door clients niet worden aangevuld — alleen Admin SDK
 *     mag een trainer toevoegen (rules.test.js tests 18b, 27b).
 *   - users/{uid}/teams/{teamId} alleen schrijven als je AL lid bent.
 * → Een server‑zijde functie met Admin SDK is hier een HARD‑EISENDE leidraad en
 *   blijft de beveiligingsgaranties onaangeroerd. (zie references/rules-emulator.md:
 *   "secrets such as invite codes belong only in the Admin-only inviteCodes tree")
 *
 * PROJECT (TEST): jo9-wisselmeester-test (zie repo‑root .firebaserc). LIVE niet
 * aangeroerd. Deployen gebeurt uitsluitend door de gebruiker (login/logout).
 *
 * RUNTIME: nodejs20 (firebase.json functions.runtime); lokaal ontwikkeld onder
 * Node v26 (SDK vereist >=18).
 * ==========================================================================
 */

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const crypto = require('crypto');

/*
 * Admin SDK: lazy geïnitialiseerd. De module blijft importeerbaar in lokale
 * unit‑tests zonder GCP‑credentials; initializeApp draait alleen bij de eerste
 * echte getDb() in de Functions‑runtime (ADC aanwezig).
 */
let adminApp = null;
function getAdminApp() {
  if (adminApp) return adminApp;
  if (!admin.apps.length) admin.initializeApp();
  adminApp = admin.apps[0];
  return adminApp;
}
// Mock‑injectie (tests) of Admin‑fallback (runtime). Handlers gebruiken getDb().
let _db = null;
// Tests injecteren een mock-DB via __setDb(__mkMockDb(seed)); de runtime
// (functions emulator / GCF) heeft _db === null → valt door naar Admin SDK.
function __setDb(db) { _db = db; }
function getDb() {
  if (_db) return _db;
  return getAdminApp().database();
}

// Pariteit met de RTDB Rules: ALLEEN een geverifieerd, niet‑anoniem account.
function requireVerifiedAccount(request) {
  const auth = request && request.auth;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  const token = auth.token || {};
  const provider = token.firebase && token.firebase.sign_in_provider;
  if (provider === 'anonymous') {
    throw new HttpsError('permission-denied', 'A verified account is required.');
  }
  if (token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'Email address must be verified.');
  }
  return auth.uid;
}

// Zelfde invariants als index.html TEAM PICKER LOGIC (consistent zijn).
function isValidTeamId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// Code: XXXX-XXXX, hoofdletters + cijfers, ambigue tekens weggelaten
// (0/O/1/I niet in de charset → minder leesfouten via WhatsApp).
const INVITE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

function normalizeInviteCode(raw) {
  if (raw == null) return '';
  const s = String(raw).trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (/^[A-Z2-9]{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4);
  if (INVITE_CODE_RE.test(s)) return s;
  return '';
}

function isValidInviteCode(code) {
  return typeof code === 'string' && INVITE_CODE_RE.test(code);
}

function randomSegment(charset, len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += charset[bytes[i] % charset.length];
  }
  return s;
}

// Server‑side leeshelpers (Admin SDK; client mag teams/leden niet lezen voor
// niet‑leden, en moet niet zelf owner/trainer claimen).
async function teamExists(db, teamId) {
  if (!isValidTeamId(teamId)) return false;
  const snap = await db.ref('teams/' + teamId + '/createdAt').once('value');
  return snap.exists();
}
async function verifyOwner(db, teamId, uid) {
  const snap = await db.ref('teams/' + teamId + '/members/' + uid).once('value');
  return snap.val() === 'owner';
}
async function isMember(db, teamId, uid) {
  const snap = await db.ref('teams/' + teamId + '/members/' + uid).once('value');
  const role = snap.val();
  return role === 'owner' || role === 'trainer';
}

// Alleen de 3 preview‑velden; nooit members/role.
async function readTeamMeta(db, teamId) {
  const club = await db.ref('teams/' + teamId + '/clubName').once('value');
  const name = await db.ref('teams/' + teamId + '/teamName').once('value');
  const season = await db.ref('teams/' + teamId + '/season').once('value');
  return {
    teamId: teamId,
    clubName: club.exists() ? club.val() : '',
    teamName: name.exists() ? name.val() : '',
    season: season.exists() ? season.val() : ''
  };
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dagen

// ---------------------------------------------------------------------------
// 1) createInviteCode  (alleen owner van een bestaand team)
// ---------------------------------------------------------------------------
exports.createInviteCode = onCall(async (request) => {
  const uid = requireVerifiedAccount(request);

  const teamId = request.data && request.data.teamId;
  if (!isValidTeamId(teamId)) {
    throw new HttpsError('invalid-argument', 'Ongeldig teamId.');
  }

  const db = getDb();

  if (!(await teamExists(db, teamId))) {
    throw new HttpsError('not-found', 'Team bestaat niet.');
  }

  // Owner‑check ALTIJD server‑side; client‑claim is niet vertrouwd.
  if (!(await verifyOwner(db, teamId, uid))) {
    throw new HttpsError('permission-denied', 'Alleen de owner kan uitnodigen.');
  }

  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;

  let code = null;
  for (let i = 0; i < 8; i++) {
    const c = randomSegment(INVITE_CHARSET, 4) + '-' + randomSegment(INVITE_CHARSET, 4);
    const snap = await db.ref('inviteCodes/' + c).once('value');
    if (!snap.exists()) {
      code = c;
      break;
    }
  }
  if (!code) {
    throw new HttpsError('internal', 'Kon geen unieke uitnodigingscode genereren.');
  }

  // Admin‑only write naar inviteCodes (clientschrijf is onmogelijk).
  await db.ref('inviteCodes/' + code).set({
    teamId: teamId,
    expiresAt: expiresAt,
    used: false,
    createdBy: uid,
    createdAt: now
  });

  return { code: code, teamId: teamId, expiresAt: expiresAt };
});

// ---------------------------------------------------------------------------
// 2) previewInvite  (read‑only; geen member‑toevoeging, geen used‑flip)
// ---------------------------------------------------------------------------
exports.previewInvite = onCall(async (request) => {
  requireVerifiedAccount(request);

  const code = normalizeInviteCode(request.data && request.data.code);
  if (!isValidInviteCode(code)) {
    throw new HttpsError('invalid-argument', 'Ongeldige invitatiecode.');
  }

  const db = getDb();
  const now = Date.now();

  const snap = await db.ref('inviteCodes/' + code).once('value');
  if (!snap.exists()) {
    throw new HttpsError('not-found', 'Uitnodiging niet gevonden.');
  }
  const entry = snap.val();
  if (entry.used === true) {
    throw new HttpsError('failed-precondition', 'Deze uitnodiging is verbruikt.');
  }
  if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) {
    throw new HttpsError('failed-precondition', 'Deze uitnodiging is verlopen.');
  }
  if (!isValidTeamId(entry.teamId)) {
    throw new HttpsError('not-found', 'Team bij deze uitnodiging is ongeldig.');
  }
  if (!(await teamExists(db, entry.teamId))) {
    throw new HttpsError('not-found', 'Team bestaat niet meer.');
  }

  // ALLEEN metadata; geen rol, geen used, geen member‑info.
  return await readTeamMeta(db, entry.teamId);
});

// ---------------------------------------------------------------------------
// 3) redeemInvite  (atomic + single‑use; nieuwe user is ALTIJD 'trainer')
// ---------------------------------------------------------------------------
// Atomisiteit: één ROOT‑transactie die conditioneel (used===false,
// not‑expired, nog geen member) tegelijkertijd used=true + members[uid]=
// 'trainer' + users-index zet. Alleen één redeem‑poging commit; de tweede ziet
// used===true → aborted. Zo ontstaat geen gedeelte‑success "used=true maar
// member mist" — alles‑of‑niets in één commit.
//
// Trade‑off (genoteerd): RTDB root‑transactie leest/schrijft de hele boom één
// keer; prima voor de kleine Wisselmeester DB. Bij groei naar Firestore
// overwegen we een server‑side transaction met preconditions.
// ---------------------------------------------------------------------------
exports.redeemInvite = onCall(async (request) => {
  const uid = requireVerifiedAccount(request);

  const code = normalizeInviteCode(request.data && request.data.code);
  if (!isValidInviteCode(code)) {
    throw new HttpsError('invalid-argument', 'Ongeldige invitatiecode.');
  }

  const db = getDb();
  const now = Date.now();

  let teamId;
  const result = await db.ref().transaction((root) => {
    if (!root || typeof root !== 'object') {
      return; // abort
    }
    const entry = (root.inviteCodes && root.inviteCodes[code]) || null;
    if (!entry) {
      return; // code bestaat niet → abort
    }
    if (entry.used === true) {
      return; // already used → abort (single‑use)
    }
    if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) {
      return; // expired → abort
    }
    const tId = entry.teamId;
    if (!isValidTeamId(tId)) {
      return; // corrupt → abort
    }
    const members = (((root.teams || {})[tId] || {}).members) || {};
    const own = members[uid];
    if (own === 'owner' || own === 'trainer') {
      return; // al lid → abort (niet consumeren)
    }

    // Deep‑clone + mutatie: NOOIR owner, ALTIJD trainer.
    const next = JSON.parse(JSON.stringify(root));
    if (!next.inviteCodes) next.inviteCodes = {};
    next.inviteCodes[code] = Object.assign({}, next.inviteCodes[code] || entry, { used: true });
    if (!next.teams) next.teams = {};
    if (!next.teams[tId]) next.teams[tId] = {};
    if (!next.teams[tId].members) next.teams[tId].members = {};
    next.teams[tId].members[uid] = 'trainer';
    if (!next.users) next.users = {};
    if (!next.users[uid]) next.users[uid] = {};
    if (!next.users[uid].teams) next.users[uid].teams = {};
    next.users[uid].teams[tId] = true;

    teamId = tId;
    return next;
  });

  if (!result.committed) {
    // Abort → bepaal de redelijk via een NON‑muterende herlezing (safe, geen race
    // op de kern‑schrijfoperatie; enkel voor de foutcode).
    const snap = await db.ref('inviteCodes/' + code).once('value');
    const e = snap.exists() ? snap.val() : null;
    if (!e) {
      throw new HttpsError('not-found', 'Uitnodiging niet gevonden.');
    }
    if (e.used === true) {
      throw new HttpsError('already-exists', 'Deze uitnodiging is al verbruikt.');
    }
    if (typeof e.expiresAt === 'number' && e.expiresAt <= now) {
      throw new HttpsError('failed-precondition', 'Deze uitnodiging is verlopen.');
    }
    if (!isValidTeamId(e.teamId) || !(await teamExists(db, e.teamId))) {
      throw new HttpsError('not-found', 'Team bij deze uitnodiging bestaat niet meer.');
    }
    throw new HttpsError('already-exists', 'Je bent al lid van dit team.');
  }

  const meta = await readTeamMeta(db, teamId);
  return {
    teamId: teamId,
    clubName: meta.clubName,
    teamName: meta.teamName,
    season: meta.season,
    role: 'trainer',
    accepted: true
  };
});

/*
 * ---------------------------------------------------------------------------
 * Mock‑infrastructuur (lokale unit‑tests; in runtime is dit echte Admin SDK)
 * ---------------------------------------------------------------------------
 * `__setDb` injecteert een fake DB zodat geen initializeApp/GCP‑creds nodig
 * zijn. De handlers lezen via `getDb()` → de mock. Tests roepen de handlers via
 * `callable.run(request)` aan (v2‑test‑hook; zie onCall → `__trigger`/`run`).
 */
function _mkMockDb(seed) {
  const envelope = { v: JSON.parse(JSON.stringify(seed || {})) };
  const snap = (v) => ({
    exists: () => v !== undefined && v !== null,
    val: () => v
  });
  const walk = (obj, parts) => {
    let cur = obj;
    for (const k of parts) {
      if (cur == null || typeof cur !== 'object' || !(k in cur)) return undefined;
      cur = cur[k];
    }
    return cur;
  };
  const writeLeaf = (parts, value) => {
    if (parts.length === 0) {
      envelope.v = value;
      return;
    }
    if (envelope.v == null || typeof envelope.v !== 'object') {
      envelope.v = {};
    }
    let node = envelope.v;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
      node = node[k];
    }
    node[parts[parts.length - 1]] = value;
  };
  const makeHandle = (path) => {
    const parts = (path || '').split('/').filter(Boolean);
    return {
      once: async () => snap(walk(envelope.v, parts)),
      set: async (value) => writeLeaf(parts, value),
      update: async (patches) => {
        for (const [p, v] of Object.entries(patches)) {
          writeLeaf(p.split('/').filter(Boolean), v);
        }
      },
      transaction: async (fn) => {
        const current = walk(envelope.v, parts);
        const next = fn(current);
        if (next === undefined || next === null) {
          return { committed: false, snapshot: snap(current) };
        }
        writeLeaf(parts, next);
        return { committed: true, snapshot: snap(next) };
      }
    };
  };
  return { ref: (path = '') => makeHandle(path) };
}

// getDb / _db / __setDb zijn bovenaan gedefinieerd (mock‑injectie of Admin fallback).
exports.__setDb = __setDb;
exports.__mkMockDb = _mkMockDb;
exports.__getDb = () => _db;
exports.__requireVerifiedAccount = requireVerifiedAccount;
exports.__isValidTeamId = isValidTeamId;
exports.__normalizeInviteCode = normalizeInviteCode;
exports.__isValidInviteCode = isValidInviteCode;
exports.__INVITE_TTL_MS = INVITE_TTL_MS;
