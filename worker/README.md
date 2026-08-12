# notifrajer-push — pouzdan Web Push server (Cloudflare Worker)

Rješava osnovni problem lokalnog rasporeda: Android može ugasiti service
worker u pozadini, pa se `setTimeout` unutar njega nikad ne pokrene. Ovaj
Worker svake minute provjerava bazu i šalje pravu Web Push notifikaciju u
tačno vrijeme — to Android/Chrome tretiraju drugačije i pouzdanije budi
uređaj, čak i kad je app satima u pozadini.

Lokalno planiranje u `sw.js` ostaje kao brzi, precizni put kad je app
nedavno korišten; ovo je sigurnosna mreža koja hvata slučajeve kad lokalni
tajmer ne uspije. App radi i **bez** ovoga — dok ne postaviš server, alarmi
rade lokalno kao i do sada.

---

# A) Postavljanje preko telefona (bez terminala)

Sve ide kroz web sučelje na `dash.cloudflare.com`. Treba ti besplatan
Cloudflare nalog.

### 1. Generiši VAPID ključeve

Otvori na telefonu: **`https://tvoj-domen/vapid-generator.html`**
(isti domen gdje ti je app — fajl je u repou).

Dodirni **Generiši ključeve**. Dobiješ dva:

| Ključ | Gdje ide | Tajno? |
|---|---|---|
| `VAPID_PUBLIC_KEY` | Worker varijabla + `index.html` | ne |
| `VAPID_PRIVATE_KEY_JWK` | Worker **secret** | **da** |

Kopiraj oba negdje (Notes, Keep) — trebaju ti u koracima ispod. Stranica ih
generiše u pregledniku i nigdje ne šalje, pa nestaju kad je zatvoriš.

### 2. Napravi bazu (D1)

`dash.cloudflare.com` → **Storage & Databases** → **D1** → **Create database**

- Ime: `notifrajer-push` → **Create**

Otvori je → tab **Console** → zalijepi sadržaj fajla `worker/schema.sql`
→ **Execute**. Treba javiti da je uspjelo.

### 3. Napravi Worker

**Compute (Workers)** → **Create** → **Start from Hello World** → **Create**

- Ime: `notifrajer-push`

### 4. Zalijepi kod

Na Workeru dodirni **Edit code** (ili `</>`). Otvori se editor sa `worker.js`
i nekim primjerom koda.

- **Označi sav postojeći kod i obriši ga**
- Zalijepi **cijeli** sadržaj fajla `worker/dashboard-worker.js`
  (to je verzija bez `import`-a, spremljena baš za ovaj editor)
- **Deploy**

### 5. Poveži bazu i upiši ključeve

Na Workeru → **Settings** → **Bindings** → **Add**:

| Tip | Ime | Vrijednost |
|---|---|---|
| D1 database | `DB` | `notifrajer-push` |
| Text (Variable) | `VAPID_PUBLIC_KEY` | javni ključ iz koraka 1 |
| Text (Variable) | `VAPID_SUBJECT` | `mailto:tvoj@email.com` |
| **Secret** | `VAPID_PRIVATE_KEY_JWK` | cijeli JSON `{"crv":...}` iz koraka 1 |

Privatni ključ mora ići kao **Secret**, ne kao obična varijabla.

### 6. Uključi cron (svaku minutu)

**Settings** → **Trigger Events** → **Add** → **Cron Trigger** → `* * * * *`

Bez ovoga baza se puni ali niko ne šalje notifikacije.

### 7. Poveži app sa serverom

Adresa Workera piše na njegovoj stranici, oblika
`https://notifrajer-push.tvoj-nalog.workers.dev`.

U `index.html` (vrh skripte) i u `sw.js` (vrh fajla) upiši:

```js
var PUSH_SERVER_URL = 'https://notifrajer-push.tvoj-nalog.workers.dev';
var VAPID_PUBLIC_KEY = 'javni ključ iz koraka 1';   // samo u index.html
```

```js
const PUSH_SERVER_URL = 'https://notifrajer-push.tvoj-nalog.workers.dev';  // sw.js
```

Commit → push → redeploy PWA. Ako koristiš Android paket, ponovo ga napravi
na PWABuilderu.

### 8. Provjeri

U app-u: **⚙ → Notifikacije → Test alarma → Pokreni**, pa **zatvori app**.
Ako notifikacija dođe dok je app zatvoren, radi.

U Worker logovima (**Observability → Logs**) vidiš zahtjeve uživo.

---

# B) Postavljanje preko terminala (wrangler)

Isto, samo brže ako imaš Node.js na računaru.

```bash
cd worker
npm install
npx wrangler login

node generate-vapid-keys.js          # ključevi
npx wrangler d1 create notifrajer-push
# → prepiši database_id u wrangler.toml
npx wrangler d1 execute notifrajer-push --remote --file=schema.sql

# javni ključ + email u [vars] u wrangler.toml, pa:
npx wrangler secret put VAPID_PRIVATE_KEY_JWK
npx wrangler deploy
npx wrangler tail                    # logovi uživo
```

Zatim korak 7 odozgo (upiši URL u `index.html` i `sw.js`).

---

## Dvije verzije istog koda

- `src/index.js` + `src/webpush.js` — za wrangler (`npx wrangler deploy`)
- `dashboard-worker.js` — isto to spojeno u jedan fajl bez `import`-a, za
  copy-paste u web editor

Ako mijenjaš logiku, mijenjaj **oba** ili odaberi jedan put i drugi obriši.

## Kako se izbjegava dupli alarm

Alarm može zazvoniti iz dva izvora — lokalnog tajmera na telefonu i push-a
sa servera. Da ne zazvoni dvaput:

- kad telefon odzvoni sam, javi serveru (`/api/cancel`) da preskoči taj
- kad stigne push, `sw.js` provjeri je li taj alarm već odzvonio u zadnjih
  5 minuta i ako jest — ignoriše ga

## Ponavljanje i vremenske zone

Worker radi u UTC-u, a telefon u tvojoj zoni. Zato klijent uz svaki alarm
šalje i lokalno vrijeme (`HH:MM`) i IANA zonu (npr. `Europe/Sarajevo`), pa
server računa sljedeće zvonjenje u tvom lokalnom vremenu. Bez toga bi alarm
u 23:45 preko prelaska na ljetno vrijeme završio na pogrešnom **danu**.

## Sigurnosna napomena

Nema login/lozinku — `deviceId` (nasumični UUID generisan u pregledniku) je
jedini identitet. Dovoljno za ovu ličnu app; ne koristiti kao pravi
multi-user sistem bez dodatne autentifikacije.
