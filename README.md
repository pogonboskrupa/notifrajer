# PIN Podsjetnik — PWA

Podsjetnik zaštićen PIN-om. Alarm se ne može ugasiti bez ispravnog koda.

## Fajlovi

```
pin-reminder-pwa/
├── index.html      ← Cijela aplikacija
├── sw.js           ← Service worker (offline + notifikacije)
├── manifest.json   ← PWA manifest
├── icon-192.svg    ← Ikona (192×192)
├── icon-512.svg    ← Ikona (512×512)
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

## Tehničke napomene

- **Service Worker** (`sw.js`) prima poruke iz aplikacije i planira notifikacije
- **Web Audio API** generira zvuk alarma
- **localStorage** čuva PIN i podsjetnike lokalno
- **Offline podrška** — aplikacija radi bez interneta nakon prvog učitavanja
- **iOS Safari**: Mora biti instalirana kao PWA (Add to Home Screen) za pozadinske notifikacije

## Sigurnost

- PIN se čuva lokalno u localStorage (nije enkriptiran)
- Za produkcijsku upotrebu, preporučuje se hashing PIN-a (npr. SHA-256 via Web Crypto API)
