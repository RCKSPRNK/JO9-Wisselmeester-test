'use strict';
/*
 * ==========================================================================
 * Wisselmeester - Fase 2C-3: "Trainer beheren via e-mailadres" (Cloud Functions)
 * ==========================================================================
 *
 * DE ENIGE plaats waar:
 *   - trainer-leden worden toegevoegd/verwijderd aan een team via e-mailadres.
 *
 * Waarom een Function (Admin SDK) en geen client-write:
 *   - members/{uid} mag door clients niet worden aangevuld — alleen Admin SDK
 *     mag een trainer toevoegen (rules.test.js tests 18b, 27b).
 *   - users/{uid}/teams/{teamId} alleen schrijven als je AL lid bent.
 *   - getAuth().getUserByEmail() is Admin-only; clients kunnen geen UID lookup.
 * → Een server-zijde functie met Admin SDK is hier een HARD-EISENDE leidraad en
 *   blijft de beveiligingsgaranties onaangeroerd. Alle writes gebeuren via
 *   Admin SDK (bypass rules), eliminerend ETag/transaction protocol issues.
 *
 * PROJECT (TEST): jo9-wisselmeester-test (zie repo-root .firebaserc). LIVE niet
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

// Server-side leeshelpers (Admin SDK; client mag teams/leden niet lezen voor
// niet-leden, en moet niet zelf owner/trainer claimen).
async function verifyOwner(db, teamId, uid) {
  const snap = await db.ref('teams/' + teamId + '/members/' + uid).once('value');
  return snap.val() === 'owner';
}
async function isMember(db, teamId, uid) {
  const snap = await db.ref('teams/' + teamId + '/members/' + uid).once('value');
  const role = snap.val();
  return role === 'owner' || role === 'trainer';
}

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
 * List team members with roles + emails (owner-only via Admin Auth SDK).
 * Client kan members lezen (rules: member can read teams/{teamId}),
 * maar niet emails van andere gebruikers (users/{uid}/email is self-only).
 */
exports.listTeamMembers = onCall({ region: 'europe-west1' }, async (request) => {
  const callerUid = requireVerifiedAccount(request);
  const teamId = request.data && request.data.teamId;

  if (!teamId || !isValidTeamId(teamId)) {
    throw new HttpsError('invalid-argument', 'Ongeldig team.');
  }

  const db = getDb();
  const auth = getAuthInstance();

  // Verplicht owner; anders kan een trainer de lijst zien — niet per design.
  if (!(await verifyOwner(db, teamId, callerUid))) {
    throw new HttpsError('permission-denied', 'Alleen de owner kan leden bekijken.');
  }

  const membersSnap = await db.ref('teams/' + teamId + '/members').once('value');
  const members = membersSnap.val() || {};

  const result = [];
  for (const [uid, role] of Object.entries(members)) {
    let email = '';
    try {
      const user = await auth.getUser(uid);
      email = user.email || '';
    } catch (e) {
      // gebruiker bestaat niet meer in Auth — skip silently
    }
    result.push({ uid: uid, role: role || 'trainer', email: email });
  }

  return { teamId: teamId, members: result };
});

/*
 * Trainer verlaat team / owner-overdracht.
 *
 * - trainer: verwijdert members/{uid} en users/{uid}/teams/{teamId}
 * - owner:    bevordert langst-aangesloten trainer (key-order; geen
 *             join-timestamp beschikbaar) → owner, verwijdert oude owner.
 *             Bij geen andere trainer: blocked met failed-precondition.
 *
 * Atomic via multi-path update: team is nooit tijdelijk ownerloos.
 */
exports.leaveTeam = onCall({ region: 'europe-west1' }, async (request) => {
  const callerUid = requireVerifiedAccount(request);
  const teamId = request.data && request.data.teamId;

  if (!teamId || !isValidTeamId(teamId)) {
    throw new HttpsError('invalid-argument', 'Ongeldig team.');
  }

  const db = getDb();

  // Check membership (path-scoped read)
  const snap = await db.ref('teams/' + teamId + '/members/' + callerUid).once('value');
  if (!snap.exists()) {
    throw new HttpsError('not-found', 'Je bent geen lid van dit team.');
  }
  const role = snap.val();

  if (role === 'owner') {
    // Find the longest-standing trainer — no join timestamp exists in the
    // database, so we use key order (deterministic, reliable).
    const membersSnap = await db.ref('teams/' + teamId + '/members').once('value');
    const members = membersSnap.val() || {};

    let newOwnerUid = null;
    for (const uid of Object.keys(members).sort()) {
      if (uid !== callerUid && members[uid] === 'trainer') {
        newOwnerUid = uid;
        break;
      }
    }

    if (!newOwnerUid) {
      // Keep owner in members? No — the user is leaving. Block.
      // But we must NOT remove the caller yet — we block before any writes.
      throw new HttpsError(
        'failed-precondition',
        'Je bent de enige eigenaar. Voeg eerst een andere trainer toe.'
      );
    }

    // Multi-path update: atomic — team never briefly ownerless.
    const updates = {};
    updates['teams/' + teamId + '/members/' + newOwnerUid] = 'owner';
    updates['teams/' + teamId + '/members/' + callerUid] = null;
    updates['users/' + callerUid + '/teams/' + teamId] = null;
    // users/{newOwnerUid}/teams/{teamId} already = true (was a trainer member)

    try {
      await db.ref().update(updates);
    } catch (e) {
      throw new HttpsError('internal',
        'Kon teamoverdracht niet voltooien: ' + (e.message || e.code));
    }

    return {
      teamId: teamId,
      uid: callerUid,
      role: 'owner',
      transferred: true,
      newOwnerId: newOwnerUid
    };
  }

  // Trainer leaving (owner stays)
  const updates = {};
  updates['teams/' + teamId + '/members/' + callerUid] = null;
  updates['users/' + callerUid + '/teams/' + teamId] = null;

  try {
    await db.ref().update(updates);
  } catch (e) {
    throw new HttpsError('internal',
      'Kon lidmaatschap niet verwijderen: ' + (e.message || e.code));
  }

  return {
    teamId: teamId,
    uid: callerUid,
    role: 'trainer',
    transferred: false
  };
});

/*
 * Complete team deletion — owner only.
 * Atomically removes teams/{teamId} (members, players, matches, meta)
 * and clears the reverse-index entry users/{uid}/teams/{teamId}
 * for every member of the team.
 */
exports.deleteTeam = onCall({ region: 'europe-west1' }, async (request) => {
  const callerUid = requireVerifiedAccount(request);
  const teamId = request.data && request.data.teamId;

  if (!teamId || !isValidTeamId(teamId)) {
    throw new HttpsError('invalid-argument', 'Ongeldig team.');
  }

  const db = getDb();

  // Verify ownership
  if (!(await verifyOwner(db, teamId, callerUid))) {
    throw new HttpsError('permission-denied',
      'Alleen de eigenaar kan een team verwijderen.');
  }

  // Get all members for reverse-index cleanup
  const membersSnap = await db.ref('teams/' + teamId + '/members').once('value');
  const members = membersSnap.val() || {};

  // Atomic multi-path delete: entire team node + reverse indices
  const updates = {};
  updates['teams/' + teamId] = null;   // members + players + matches + meta
  for (const uid of Object.keys(members)) {
    updates['users/' + uid + '/teams/' + teamId] = null;
  }

  try {
    await db.ref().update(updates);
  } catch (e) {
    throw new HttpsError('internal',
      'Kon team niet verwijderen: ' + (e.message || e.code));
  }

  return { teamId: teamId, deleted: true };
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
      remove: async () => writeLeaf(parts, null),
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
exports.__setAuth = __setAuth;