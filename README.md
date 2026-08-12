# PIN Podsjetnik — PWA

Podsjetnik zaštićen PIN-om. Alarm se ne može ugasiti bez ispravnog koda.

## Fajlovi

```
pin-reminder-pwa/
├── index.html               ← Cijela aplikacija
├── sw.js                    ← Service worker (offline + notifikacije)
├── manifest.json            ← PWA manifest
├── vapid-generator.html     ← Generator VAPID ključeva (za push server)
├── worker/                  ← Cloudflare Worker: push server (opcionalno)
├── icon-192.png/.svg        ← Ikona (192×192, any + maskable)
├── icon-512.png/.svg        ← Ikona (512×512, any + maskable)
├── apple-touch-icon.png     ← iOS ikona (180×180)
├── screenshot-narrow-*.png  ← Screenshotovi za install UI (mobilni)
├── screenshot-wide-1.png    ← Screenshot za install UI (desktop)
└── README.md
```

## Deployment (HTTPS je obavezan za PWA!)

### Opcija 1 — Netlify (besplatno, najlakše)
1. Idi na https://netlify.com → "Add new site" → "Deploy manually"
2. Prevuci cijeli folder na stranicu
3. Gotovo! Netlify automatski daje HTTPS

### Opcija 2 — GitHub Pages
1. Napravi novi GitHub repozitorij
2. Upload svih fajlova
3. Settings → Pages → Deploy from branch (main)
4. URL: https://[tvoj-username].github.io/[repo-name]

### Opcija 3 — Vercel
```bash
npm i -g vercel
cd pin-reminder-pwa
vercel
```

### Opcija 4 — Lokalno testiranje
```bash
# Trebaš HTTPS lokalno (SW ne radi na http://)
npx serve . --ssl-cert cert.pem --ssl-key key.pem
# ILI koristi ngrok:
npx serve .
ngrok http 3000
```

## Kako koristiti

1. **Otvori** aplikaciju u pregledaču (Chrome, Edge, Firefox, Safari)
2. **Postavi PIN** (4–6 brojeva) pri prvom pokretanju
3. **Dozvoli notifikacije** kad te pita (bitno za pozadinski rad!)
4. **Instaliraj** na uređaj (pojavljuje se gumb "Instaliraj" ili banner u pregledaču)
5. **Dodaj podsjetnike** s vremenom i ponavljanjem
6. Kad alarm zazvoni — ne možeš ga ugasiti bez PIN-a!

## Tabovi

- **Dodaj / Lista** — podsjetnici s alarmom zaštićenim PIN-om. Ponavljanje:
  jednom, svaki dan, radni dani ili **odabrani dani** u sedmici. Dodirni
  podsjetnik u listi da ga izmijeniš; lista pokazuje i za koliko zvoni
- **Bilješke** — kategorije (npr. „More", „Kamp") i unutar svake lista stvari koje ti trebaju, s kvačicom za odrađeno
- **Kalendar** — mjesečni pregled; klikni na dan i dodaj šta i kad trebaš uraditi (tačkica označava dane sa zadacima). Ako postaviš vrijeme, zadatak zvoni kao alarm istog trenutka i traži PIN za gašenje — potpuno isto kao i obični podsjetnici
- **⚙** — PIN, tema (auto/svijetla/tamna), odgoda alarma, **test alarma**,
  **sigurnosna kopija** (izvoz/uvoz), brisanje podataka

## Pakovanje u aplikaciju (PWABuilder)

Manifest je pripremljen za PWABuilder — ima `screenshots` (mobilni + desktop),
`display_override`, `lang`/`dir`, `launch_handler`, `handle_links`, maskable ikone
i tri shortcut-a (Dodaj / Kalendar / Bilješke).

1. Prvo **deployaj na HTTPS** (Netlify, GitHub Pages, Vercel — vidi gore).
   PWABuilder ne može pakovati `localhost` ni `http://`.
2. Idi na https://www.pwabuilder.com i zalijepi URL svoje stranice.
3. Provjeri report card — trebao bi proći sve obavezne stavke.
4. **Package For Stores** → Android (`.aab`/`.apk`) ili Windows.
5. Za Android: PWABuilder generiše i `assetlinks.json` — postavi ga na
   `https://tvoj-domen/.well-known/assetlinks.json` da se ukloni URL traka.

**Bitno za alarme u pakovanoj aplikaciji:**
- Dozvoli notifikacije pri prvom pokretanju, inače alarm ne radi u pozadini.
- U Android postavkama isključi optimizaciju baterije za aplikaciju
  (Settings → Apps → PIN Podsjetnik → Battery → Unrestricted), inače sistem
  može uspavati service worker i odgoditi alarm.

## Pouzdanost alarma

Alarm ide kroz tri nezavisna puta, jer nijedan sam nije dovoljan na Androidu:

1. **Tajmer u service workeru** — precizan dok je worker živ
2. **Provjera u stranici** (svakih 15 s) — hvata slučaj kad je worker ubijen
   a app otvoren
3. **Push server** (opcionalno, `worker/`) — jedini put koji radi kad je app
   potpuno zatvoren satima. Vidi `worker/README.md`

Sva tri koriste isti `lf_<id>` / `fired/<id>` marker pa alarm ne zazvoni
dvaput. Ako sistem uspava telefon i alarm zakasni, zazvoni čim se app probudi
i jasno se označi kao **zakasnio** umjesto da se tiho izgubi.

**Odgodi** ne zaobilazi PIN — samo pomjera isti alarm; ugasiti ga i dalje
možeš jedino ispravnim PIN-om.

## Sigurnosna kopija

Podaci žive samo u `localStorage` ovog uređaja. **⚙ → Sigurnosna kopija →
Izvezi** sprema `.json` sa svime (PIN, podsjetnici, bilješke, kalendar);
**Uvezi** ga vraća. Bez toga brisanje podataka preglednika znači gubitak svega.

## Tehničke napomene

- **Service Worker** (`sw.js`) prima poruke iz aplikacije i planira notifikacije.
  Duga čekanja se lančaju u komadima jer `setTimeout` puca preko ~24.8 dana.
  Kad ga sistem ubije i ponovo pokrene, `activate` se **ne** okida ponovo, pa
  se raspored obnavlja pri prvom sljedećem događaju (fetch/push/poruka) —
  bez toga bi se svi tajmeri tiho izgubili
- **Ponavljanje** se računa istom funkcijom (`computeNextFire`) u `index.html`,
  `sw.js` i na serveru; ako se raziđu, alarm zazvoni dvaput
- **Web Audio API** generira zvuk alarma
- **localStorage** čuva PIN, podsjetnike, bilješke i kalendar lokalno
- **Offline podrška** — aplikacija radi bez interneta nakon prvog učitavanja;
  navigacija ide cache-first pa se alarm ekran otvara odmah po kliku na notifikaciju
- **Pending notifikacija** se prikazuje tek kad je alarm unutar 24h, da zadaci
  zakazani mjesecima unaprijed ne zatrpavaju traku s notifikacijama
- **iOS Safari**: Mora biti instalirana kao PWA (Add to Home Screen) za pozadinske notifikacije

## Sigurnost

- PIN se čuva lokalno u localStorage (nije enkriptiran) — štiti od gašenja
  alarma, ne od nekog ko ima pristup uređaju i zna gdje gledati
- Za produkcijsku upotrebu, preporučuje se hashing PIN-a (npr. SHA-256 via Web Crypto API)
- Sigurnosna kopija sadrži PIN u čitljivom obliku — čuvaj je kao i sam PIN
