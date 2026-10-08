# Wisselmeester — Cloud Functions (Fase 2C-3)

TEST-project: `jo9-wisselmeester-test` (zie `.firebaserc`). LIVE wordt niet
aangeroerd.

## Runtime
Node.js 18+; gemoduleerd via `firebase-functions` v5 (v2 callables) +
`firebase-admin` v13. Zie `firebase.json` -> `functions.runtime: nodejs20`.

## Endpoint (basis = stubs, TODO)
- `createInviteCode`  — eigenaar laat een code aanmaken (owner-check server-side).
- `previewInvite`     — invitee typt code -> preview (club/team/seizoen/trainer).
- `redeemInvite`      — invitee accepteert -> trainer lid (atomisch, single-use).

Zie comments bovenaan `index.js` voor de exacte TODO/security-garanties.

## Test (lokale basis, geen emulator)
```
npm test
# of: node --test test/setup.test.js
```
Verifieert alleen dat de module laadt en de 3 callables + helpers aanwezig zijn.

## Emulator (lokaal, optioneel)
Gebruik de bestaande database-emulator via de rules-emulator scripts
(`start-database-emulator.sh`) en de database-rules via
`firebase-rules/firebase.json`. Voor de Functions-emulator:
```
firebase emulators:start --only functions
```
(vanaf repo-root; gebruikt deze root `firebase.json`). Een gecombineerde
database+functions-emulator wordt later toegevoegd; voor nu blijven de
rules-scripts ongewijzigd (`--config firebase-rules/firebase.json`).

## Deploy (alleen door de gebruiker)
Deze basis logt niet in en deployed niets. Voor deploy:
1. `firebase login` (alleen TEST-account) — NOOIT een account dat ook LIVE recht geeft.
2. `firebase deploy --only functions`.
3. `firebase logout`.
inviteCodes blijft admin-only; clientschrijf naar inviteCodes en members is en
blijft onmogelijk — ook na deze functies.
