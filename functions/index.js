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

const { initializeApp, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
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
  const apps = getApps();
  if (apps.length === 0) {
    adminApp = initializeApp();
  } else {
    adminApp = apps[0];
  }
  return adminApp;
}
// Mock‑injectie (tests) of Admin‑fallback (runtime). Handlers gebruiken getDb().
let _db = null;
// Tests injecteren een mock-DB via __setDb(__mkMockDb(seed)); de runtime
// (functions emulator / GCF) heeft _db === null → valt door naar Admin SDK.
function __setDb(db) { _db = db; }
function getDb() {
  if (_db) return _db;
  return getDatabase(getAdminApp());
}
// Mock‑injectie (tests) voor Auth Admin SDK. Runtime heeft _auth === null →
// valt door naar getAuth(getAdminApp()). Tests injecteren via __setAuth().
let _auth = null;
function __setAuth(auth) { _auth = auth; }
function getAuthInstance() {
  if (_auth) return _auth;
  return getAuth(getAdminApp());
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
exports.createInviteCode = onCall({ region: 'europe-west1' }, async (request) => {
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
exports.previewInvite = onCall({ region: 'europe-west1' }, async (request) => {
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
// 3) redeemInvite  (atomic + single-use; nieuwe user is ALTIJD 'trainer')
// ---------------------------------------------------------------------------
// Atomisiteit via path-scoped transaction op inviteCodes/[code]:
//   - Fase 1: read + validate code (path-scoped reads, geen root lock)
//   - Fase 2: membership check (path-scoped read, geen root lock)
//   - Fase 3: transaction claimt code → used=true (path-scoped, single-use)
//   - Fase 4: schrijf members[uid]=trainer + users[uid].teams[teamId]=true
//   - Fase 5: return team metadata
//
// ROOT-transactie verwijderd: db.ref().transaction() leest/schrijft de hele
// boom — elke onbedoelde write (Realtime-listener writes naar /team, /users)
// veroorzaakt conflict → retry exhaustion → misleiding 409. Path-scoped fix:
// alleen inviteCodes/[code] wordt gecontroleerd → geen spurious conflicts.
//
// Safety-checks ongewijzigd: code bestaat, niet verbruikt, niet verlopen,
// team bestaat, nog geen member. Bij transactie-abort (code door concurrerende
// caller verbruikt) → 409 "al verbruikt". Bij write-falen na claim → rollback
// + 500 "probeer opnieuwk". Echte al-lid → 409 "al lid". (zie references/)
// ---------------------------------------------------------------------------
exports.redeemInvite = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = requireVerifiedAccount(request);

  const code = normalizeInviteCode(request.data && request.data.code);
  if (!isValidInviteCode(code)) {
    throw new HttpsError('invalid-argument', 'Ongeldige invitatiecode.');
  }

  const db = getDb();
  const now = Date.now();

  // Fase 1: Read + validate invite code (path-scoped, no root lock)
  const snap = await db.ref('inviteCodes/' + code).once('value');
  const entry = snap.exists() ? snap.val() : null;

  if (!entry) {
    throw new HttpsError('not-found', 'Uitnodiging niet gevonden.');
  }
  if (entry.used === true) {
    throw new HttpsError('already-exists', 'Deze uitnodiging is al verbruikt.');
  }
  if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) {
    throw new HttpsError('failed-precondition', 'Deze uitnodiging is verlopen.');
  }

  const teamId = entry.teamId;
  if (!isValidTeamId(teamId)) {
    throw new HttpsError('not-found', 'Team bij deze uitnodiging bestaat niet meer.');
  }
  if (!(await teamExists(db, teamId))) {
    throw new HttpsError('not-found', 'Team bij deze uitnodiging bestaat niet meer.');
  }

  // Fase 2: Check membership (path-scoped read, no root lock).
  // 409 "al lid" ALLEEN als user echt al owner/trainer is.
  const _isMember = await isMember(db, teamId, uid);
  if (_isMember) {
    throw new HttpsError('already-exists', 'Je bent al lid van dit team.');
  }

  // Fase 3: Atomisch claim via path-scoped transaction op inviteCodes/[code].
  // Operates ALLEEN op inviteCodes/[code] -> geen conflict met writes naar
  // /team, /users, /teams of andere nodes.
  let claimed = false;
  const txn = await db.ref('inviteCodes/' + code).transaction((current) => {
    if (!current || typeof current !== 'object') {
      return; // abort — code verwijderd
    }
    if (current.used === true) {
      return; // abort — door andere caller verbruikt
    }
    if (typeof current.expiresAt === 'number' && current.expiresAt <= now) {
      return; // abort — verlopen
    }
    claimed = true;
    return Object.assign({}, current, { used: true });
  });

  if (!txn.committed || !claimed) {
    // Transaction aborted -> code werd door andere caller verbruikt/verlopen
    console.error(JSON.stringify({
      evt: 'redeem_invite_conflict',
      committed: false,
      isMember: _isMember
    }));
    throw new HttpsError('already-exists', 'Deze uitnodiging is al verbruikt.');
  }

  // Fase 4: Voeg trainer + user-index toe (path-scoped writes).
  try {
    await db.ref('teams/' + teamId + '/members/' + uid).set('trainer');
    await db.ref('users/' + uid + '/teams/' + teamId).set(true);
  } catch (err) {
    // Rollback: geef code weer vrij -> niet-leden mogen opnieuw proberen
    try {
      await db.ref('inviteCodes/' + code).update({ used: false });
    } catch (_rollbackErr) {
      console.error(JSON.stringify({ evt: 'redeem_invite_rollback_failed' }));
    }
    console.error(JSON.stringify({ evt: 'redeem_invite_write_failed' }));
    throw new HttpsError('internal', 'Kon deelnemer niet toevoegen. Probeer het opnieuwk.');
  }

  // Fase 5: Return metadata
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
 * Option B: Trainer toevoegen via e-mailadres (zonder uitnodigingscode).
 * De owner voert een trainer in via e-mail. De functie zoekt de UID bij die
 * e-mail via Firebase Auth Admin SDK, en schrijft members/{uid} = 'trainer'
 * plus een reverse-index in users/{uid}/teams/{teamId} (Admin SDK write,
 * omzeilt rules en de kapotte transaction() in Cloud Functions).
 */
exports.addTrainerByEmail = onCall({ region: 'europe-west1' }, async (request) => {
  const callerUid = requireVerifiedAccount(request);
  const email = (request.data && request.data.email || '').trim().toLowerCase();
  const teamId = request.data && request.data.teamId;

  if (!teamId || !isValidTeamId(teamId)) {
    throw new HttpsError('invalid-argument', 'Ongeldig team.');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Ongeldig e-mailadres.');
  }

  const db = getDb();
  const auth = getAuthInstance();

  // 1. Verify caller is owner of the team
  if (!(await verifyOwner(db, teamId, callerUid))) {
    throw new HttpsError('permission-denied', 'Alleen de owner kan trainers toevoegen.');
  }

  // 2. Look up the trainer's UID by email via Admin Auth SDK
  let trainerRecord;
  try {
    trainerRecord = await auth.getUserByEmail(email);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'Geen gebruiker met dit e-mailadres gevonden.');
    }
    throw new HttpsError('internal', 'Fout bij opzoeken gebruiker: ' + (e.message || e.code));
  }

  const trainerUid = trainerRecord.uid;

  // 3. Verify the account is verified (non-anonymous)
  if (trainerRecord.emailVerified !== true) {
    throw new HttpsError('failed-precondition',
      'De gebruiker heeft zijn e-mailadres nog niet geverifieerd.');
  }
  if (trainerRecord.providerData && trainerRecord.providerData.length === 0) {
    throw new HttpsError('failed-precondition',
      'Anonieme accounts kunnen geen trainer zijn.');
  }

  // 4. Check the trainer is not already a member
  if (await isMember(db, teamId, trainerUid)) {
    throw new HttpsError('already-exists',
      'Deze trainer is al lid van dit team.');
  }

  // 5. Add the trainer as 'trainer' (Admin SDK write — bypasses rules)
  const trainerRef = db.ref('teams/' + teamId + '/members/' + trainerUid);
  const reverseRef = db.ref('users/' + trainerUid + '/teams/' + teamId);

  try {
    // Write members/{uid} = 'trainer'
    await trainerRef.set('trainer');
    // Write reverse-index users/{uid}/teams/{teamId} = true
    await reverseRef.set(true);
  } catch (e) {
    // If the second write fails, roll back the first
    await trainerRef.remove().catch(() => {});
    throw new HttpsError('internal',
      'Fout bij toevoegen trainer: ' + (e.message || e.code));
  }

  return {
    teamId: teamId,
    uid: trainerUid,
    email: email,
    role: 'trainer'
  };
});

/*
 * Option B: Trainer verwijderen via e-mailadres (beheer door owner).
 * Verwijdert members/{uid} en users/{uid}/teams/{teamId}.
 */
exports.removeTrainer = onCall({ region: 'europe-west1' }, async (request) => {
  const callerUid = requireVerifiedAccount(request);
  const email = (request.data && request.data.email || '').trim().toLowerCase();
  const teamId = request.data && request.data.teamId;

  if (!teamId || !isValidTeamId(teamId)) {
    throw new HttpsError('invalid-argument', 'Ongeldig team.');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Ongeldig e-mailadres.');
  }

  const db = getDb();
  const auth = getAuthInstance();

  // 1. Verify caller is owner
  if (!(await verifyOwner(db, teamId, callerUid))) {
    throw new HttpsError('permission-denied', 'Alleen de owner kan trainers verwijderen.');
  }

  // 2. Look up the trainer's UID by email
  let trainerRecord;
  try {
    trainerRecord = await auth.getUserByEmail(email);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'Geen gebruiker met dit e-mailadres gevonden.');
    }
    throw new HttpsError('internal', 'Fout bij opzoeken gebruiker: ' + (e.message || e.code));
  }

  const trainerUid = trainerRecord.uid;

  // 3. Check the trainer is actually a member with role 'trainer'
  const snap = await db.ref('teams/' + teamId + '/members/' + trainerUid).once('value');
  if (!snap.exists() || snap.val() !== 'trainer') {
    throw new HttpsError('not-found',
      'Deze trainer is niet lid van dit team.');
  }

  // 4. Remove both the membership and reverse-index
  await db.ref('teams/' + teamId + '/members/' + trainerUid).remove();
  await db.ref('users/' + trainerUid + '/teams/' + teamId).remove();

  return {
    teamId: teamId,
    uid: trainerUid,
    email: email,
    role: 'removed'
  };
});

/*
 * ---------------------------------------------------------------------------
 * Mock‑infrastructuur (lokale unit‑tests; in runtime is dit echte Admin SDK)
 * ---------------------------------------------------------------------------
 * `__setDb` en `__setAuth` injecteren mocks zodat geen initializeApp/GCP‑creds
 * nodig zijn. De handlers lezen via `getDb()`/`getAuthInstance()` → de mock.
 * Tests roepen de handlers via `callable.run(request)` aan
 * (v2‑test‑hook; zie onCall → `__trigger`/`run`).
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
          writeLeaf([...parts, ...p.split('/').filter(Boolean)], v);
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
exports.__setAuth = __setAuth;
