# notifrajer-push — pouzdan Web Push server (Cloudflare Worker)

Rješava osnovni problem lokalnog rasporeda: Android može ugasiti service
worker u pozadini, pa se `setTimeout` unutar njega nikad ne pokrene. Ovaj
Worker svake minute provjerava bazu i šalje pravu Web Push notifikaciju u
tačno vrijeme — to Android/Chrome tretiraju drugačije i pouzdanije budi
uređaj, čak i kad je app satima u pozadini.

Lokalno planiranje u `sw.js` ostaje kao brzi, precizni put kad je app
nedavno korišten; ovo je sigurnosna mreža koja hvata slučajeve kad lokalni
tajmer ne uspije.

## Šta ti treba

- Besplatan Cloudflare nalog: https://dash.cloudflare.com/sign-up
- Node.js (već ga imaš ako si ovo čitao preko repoa)

## Koraci

### 1. Instaliraj wrangler i prijavi se

```bash
cd worker
npm install
npx wrangler login
```

Ovo otvara browser za prijavu na Cloudflare nalog.

### 2. Generiši VAPID ključeve (tvoje, ne moje iz razgovora)

```bash
node generate-vapid-keys.js
```

Ispisat će dvije stvari — sačuvaj oboje, trebat će ti u koracima ispod.

### 3. Napravi D1 bazu

```bash
npx wrangler d1 create notifrajer-push
```

Ispisat će nešto poput:
```toml
[[d1_databases]]
binding = "DB"
database_name = "notifrajer-push"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Kopiraj taj `database_id` i zamijeni `REPLACE_WITH_YOUR_D1_DATABASE_ID` u
`wrangler.toml`.

### 4. Primijeni šemu na bazu

```bash
npx wrangler d1 execute notifrajer-push --remote --file=schema.sql
```

### 5. Upiši VAPID javni ključ u wrangler.toml

Otvori `wrangler.toml`, u `[vars]` sekciji zamijeni:
- `VAPID_PUBLIC_KEY` → javni ključ iz koraka 2
- `VAPID_SUBJECT` → `mailto:tvoj-email@nesto.com` (bilo koji validan email, koristi ga push servis samo ako treba kontaktirati vlasnika)

### 6. Upiši privatni ključ kao secret (NIKAD u wrangler.toml)

```bash
npx wrangler secret put VAPID_PRIVATE_KEY_JWK
```

Zalijepi JSON iz koraka 2 (cijeli red počevši sa `{"crv":...`) kad te pita.

### 7. Deploy

```bash
npx wrangler deploy
```

Ispisat će URL poput `https://notifrajer-push.tvoj-nalog.workers.dev` —
to je URL koji ide u `index.html` (vidi ispod).

### 8. Poveži app s workerom

U `index.html`, na vrhu skripte, postavi:
```js
var PUSH_SERVER_URL = 'https://notifrajer-push.tvoj-nalog.workers.dev';
var VAPID_PUBLIC_KEY = 'javni ključ iz koraka 2';
```

Commit, push, redeploy PWA (i ponovo napravi PWABuilder paket ako koristiš
Android app).

## Provjera da radi

```bash
npx wrangler tail
```

Ovo prati logove uživo. Otvori app na telefonu, dozvoli notifikacije, dodaj
podsjetnik za par minuta unaprijed — trebao bi vidjeti zahtjeve u logu, i
cron worker bi trebao pokušati poslati push kad dođe vrijeme.

## Sigurnosna napomena

Nema login/lozinku — `deviceId` (nasumični UUID generisan u pregledniku) je
jedini identitet. Dovoljno za ovu ličnu app; ne koristiti kao pravi
multi-user sistem bez dodatne autentifikacije.
