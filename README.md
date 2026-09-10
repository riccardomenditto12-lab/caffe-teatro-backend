# Backend — Caffè del Teatro

Server per la chiamata cameriere e gli ordini al tavolo, con gestione delle
sessioni (unione/separazione/chiusura tavoli) come discusso.

## Avvio rapido

```
npm install
npm start
```

Il server parte su `http://localhost:3000`.
Dashboard bancone: `http://localhost:3000/dashboard.html`

## Collegare i QR code già generati

Con lo script Python di prima hai creato una cartella tipo
`output/caffè-del-teatro/mapping.json`. Per farla conoscere al backend:

```
node lib/importTokens.js /percorso/a/mapping.json
```

Da rifare ogni volta che aggiungi/rigeneri tavoli.

## Come collegare le pagine del sito

Il sito ora legge il menu direttamente da qui (`GET /api/menu`): non è più
scritto a mano nell'HTML. In `sito-completo.html` c'è già una variabile
`API_BASE` in cima allo script — cambiala con l'indirizzo vero del server
quando è online (in locale lascia `http://localhost:3000`).

Nel file `chiama-al-tavolo.html` standalone (se lo usi separato da
`sito-completo.html`), applica la stessa logica già presente nella versione
combinata: leggere il token dalla querystring dell'URL (`?t=xxxxx`, quello
scritto dal QR) e chiamare `/api/call`:

```js
const API_BASE = "https://IL-TUO-DOMINIO.it";
const TOKEN = new URLSearchParams(window.location.search).get("t");

await fetch(`${API_BASE}/api/call`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: TOKEN }),
});
```

## Pannello gestore (`admin.html`)

Il titolare del bar modifica categorie, voci, descrizioni e prezzi da
`/admin.html`, senza toccare codice:

- password di default: `cambiami123` — **cambiala** impostando la variabile
  d'ambiente `ADMIN_PASSWORD` sul servizio di hosting prima di consegnare
  il prodotto a un cliente vero
- ogni modifica resta solo nel browser finché non si preme **"Salva tutto"**
- si possono aggiungere/eliminare sia singole voci che intere categorie
- il sito del cliente vede le modifiche al prossimo caricamento della pagina
  (non serve nessun redeploy)

## Gestione tavoli (unione / separazione / chiusura)

Tutto si fa dalla dashboard (`dashboard.html`), niente comandi manuali:

- **Unisci tavoli**: pulsante in alto, seleziona i tavoli da accostare
- **Separa**: appare sulla card quando un tavolo è da solo in una sessione
  condivisa (per tornare a tavoli indipendenti)
- **Chiudi conto**: libera il/i tavolo/i per il prossimo cliente

Le chiamate cameriere e gli ordini ancora aperti **seguono automaticamente**
il tavolo quando lo unisci o lo separi — non si perdono e non restano
agganciati al posto sbagliato.

## Deploy gratuito (Railway/Render + Netlify/Vercel)

**Backend su Railway (consigliato, più semplice) o Render:**

1. Crea un repository GitHub con questa cartella `backend/` dentro
2. Vai su [railway.app](https://railway.app) (o [render.com](https://render.com)),
   registrati con l'account GitHub
3. "New Project" → "Deploy from GitHub repo" → seleziona il repository
4. Imposta la variabile d'ambiente `ADMIN_PASSWORD` con una password vera
   (menu Settings → Variables)
5. Railway/Render rilevano `package.json` e avviano `npm start` da soli
6. Al termine del deploy ottieni un indirizzo tipo
   `https://tuoprogetto.up.railway.app` — è il tuo `API_BASE`

Il piano gratuito di Railway ha un piccolo credito mensile incluso, quello di
Render "sleeppa" il server dopo un po' di inattività (si riattiva al primo
accesso con qualche secondo di ritardo) — per iniziare va benissimo, per un
locale con traffico reale valuta il piano a pagamento più economico quando
il progetto genera ricavi.

**Sito statico su Netlify o Vercel:**

1. Nei file del sito (`sito-completo.html` o i file separati), imposta
   `API_BASE` con l'indirizzo ottenuto da Railway/Render
2. Vai su [netlify.com](https://netlify.com) (o [vercel.com](https://vercel.com))
3. Trascina la cartella con i file HTML nell'area di deploy (drag & drop,
   nessun account GitHub necessario per iniziare)
4. Ottieni un indirizzo tipo `https://tuosito.netlify.app`
5. (Facoltativo) Collega un dominio vero da Impostazioni → Domini

**Ordine consigliato:** prima il backend (così hai subito `API_BASE`), poi
il sito con quell'indirizzo già inserito, poi rigeneri i QR con
`generate_qr_codes.py` usando come `BASE_URL` l'indirizzo Netlify/Vercel
del sito (non quello del backend).

## Note prima di andare in produzione

- Oggi i dati vivono in un file `db.json` accanto al server: va benissimo
  per un singolo locale con carico ridotto, ma se in futuro vuoi gestire
  più bar o più traffico, questo è il pezzo da sostituire con un vero
  database (Postgres/SQLite). Su Railway/Render, verifica che il piano
  scelto mantenga un file system persistente tra i riavvii, altrimenti
  `db.json` (e quindi il menu salvato) si resetta ad ogni deploy.
- Attiva HTTPS: i tag NFC/QR funzionano meglio (e alcuni browser lo
  richiedono) con connessioni sicure — Railway/Render/Netlify/Vercel lo
  danno già incluso di default.
- La password del pannello gestore (`ADMIN_PASSWORD`) è una protezione
  minima, pensata per un solo locale gestito da una persona di fiducia.
  Prima di vendere a più bar, sostituiscila con un vero sistema di login
  (un account per locale).

