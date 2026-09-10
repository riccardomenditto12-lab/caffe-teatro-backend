// lib/store.js
//
// Livello dati minimale, basato su un file JSON (db.json) invece di un vero
// database: per un singolo locale è più che sufficiente e non richiede
// installare/compilare librerie native. Se in futuro servirà scalare a più
// locali o più carico, questa è la parte da sostituire con Postgres/SQLite.
//
// CONCETTI CHIAVE
// - token: identificativo fisso stampato sul QR/tag NFC di un tavolo fisico.
//          Non cambia mai, anche se il tavolo viene spostato in sala.
// - sessione (session): il "conto" logico a cui sono agganciati uno o più
//          token in un dato momento. Chiamate e ordini sono sempre legati
//          a una sessione, mai direttamente al token.
// - unione tavoli: più token vengono agganciati alla stessa sessione.
// - separazione: un token viene staccato dalla sessione condivisa e ne
//          riceve una nuova, tutta sua.
// - chiusura: la sessione viene marcata chiusa e i suoi token vengono
//          liberati (pronti per una nuova sessione al prossimo cliente).

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "db.json");

function emptyDb() {
  return {
    tokens: {},   // token -> { table, sessionId }
    sessions: {}, // id -> { status: 'open'|'closed', createdAt, closedAt }
    calls: [],    // { id, sessionId, token, table, status, createdAt }
    orders: [],   // { id, sessionId, token, table, items, note, status, createdAt }
    nextSessionId: 1,
    nextCallId: 1,
    nextOrderId: 1,
    menu: null,   // popolato al primo avvio con defaultMenu()
    settings: { siteUrl: "" }, // URL pubblico del sito, usato per generare i QR
  };
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const db = emptyDb();
    save(db);
    return db;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

/** Registra o aggiorna un token con la sua etichetta tavolo (usato da importTokens.js). */
function ensureToken(token, table) {
  const db = load();
  if (!db.tokens[token]) {
    db.tokens[token] = { table, sessionId: null };
  } else {
    db.tokens[token].table = table;
  }
  save(db);
  return db.tokens[token];
}

const crypto = require("crypto");

/** Genera un token casuale di 8 caratteri alfanumerici (stesso formato dello script Python). */
function generateToken() {
  return crypto.randomBytes(6).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
}

/** Crea un nuovo tavolo con token casuale (usato dal pannello gestore, nessun terminale richiesto). */
function addTable(tableLabel) {
  const db = load();
  let token;
  do {
    token = generateToken();
  } while (db.tokens[token]); // evita, in teoria, collisioni

  db.tokens[token] = { table: tableLabel, sessionId: null };
  save(db);
  return { token, table: tableLabel };
}

/** Rimuove un tavolo (il QR stampato smette di funzionare). */
function deleteTable(token) {
  const db = load();
  delete db.tokens[token];
  save(db);
}

function getSettings() {
  const db = load();
  return db.settings || { siteUrl: "" };
}

function saveSettings(settings) {
  const db = load();
  db.settings = settings;
  save(db);
  return db.settings;
}

function tokenExists(db, token) {
  return Object.prototype.hasOwnProperty.call(db.tokens, token);
}

/** Ritorna l'id sessione attiva per un token, creandone una nuova se non esiste o è chiusa. */
function resolveSession(db, token) {
  const t = db.tokens[token];
  if (!t) {
    const err = new Error("Token sconosciuto: " + token);
    err.code = "UNKNOWN_TOKEN";
    throw err;
  }
  if (t.sessionId && db.sessions[t.sessionId] && db.sessions[t.sessionId].status === "open") {
    return t.sessionId;
  }
  const id = db.nextSessionId++;
  db.sessions[id] = { status: "open", createdAt: Date.now(), closedAt: null };
  t.sessionId = id;
  return id;
}

function addCall(token) {
  const db = load();
  const sessionId = resolveSession(db, token);
  const call = {
    id: db.nextCallId++,
    sessionId,
    token,
    table: db.tokens[token].table,
    status: "pending",
    createdAt: Date.now(),
  };
  db.calls.push(call);
  save(db);
  return call;
}

function addOrder(token, items, note) {
  const db = load();
  const sessionId = resolveSession(db, token);
  const order = {
    id: db.nextOrderId++,
    sessionId,
    token,
    table: db.tokens[token].table,
    items: items || [],
    note: note || "",
    status: "pending",
    createdAt: Date.now(),
  };
  db.orders.push(order);
  save(db);
  return order;
}

/** Unisce più token nella stessa nuova sessione condivisa (es. tavoli accostati per una comitiva). */
function mergeTokens(tokens) {
  const db = load();
  for (const t of tokens) {
    if (!tokenExists(db, t)) {
      const err = new Error("Token sconosciuto: " + t);
      err.code = "UNKNOWN_TOKEN";
      throw err;
    }
  }

  // sessioni precedenti dei token coinvolti, per portarsi dietro chiamate/ordini ancora aperti
  const oldSessionIds = new Set(
    tokens.map((t) => db.tokens[t].sessionId).filter((sid) => sid != null)
  );

  const id = db.nextSessionId++;
  db.sessions[id] = { status: "open", createdAt: Date.now(), closedAt: null };

  for (const t of tokens) {
    db.tokens[t].sessionId = id;
  }

  // le chiamate/ordini pendenti dei token uniti seguono il tavolo nella nuova sessione
  for (const call of db.calls) {
    if (tokens.includes(call.token) && oldSessionIds.has(call.sessionId)) {
      call.sessionId = id;
    }
  }
  for (const order of db.orders) {
    if (tokens.includes(order.token) && oldSessionIds.has(order.sessionId)) {
      order.sessionId = id;
    }
  }

  // le vecchie sessioni restano solo come storico: chiuse, non più mostrate in dashboard
  for (const sid of oldSessionIds) {
    if (db.sessions[sid] && db.sessions[sid].status === "open") {
      db.sessions[sid].status = "closed";
      db.sessions[sid].closedAt = Date.now();
    }
  }

  save(db);
  return id;
}

/** Stacca un singolo token da una sessione condivisa, assegnandogli una sessione nuova e indipendente. */
function splitToken(token) {
  const db = load();
  if (!tokenExists(db, token)) {
    const err = new Error("Token sconosciuto: " + token);
    err.code = "UNKNOWN_TOKEN";
    throw err;
  }
  const oldSessionId = db.tokens[token].sessionId;

  const id = db.nextSessionId++;
  db.sessions[id] = { status: "open", createdAt: Date.now(), closedAt: null };
  db.tokens[token].sessionId = id;

  // le chiamate/ordini di QUESTO tavolo seguono lui nella sessione nuova,
  // quelli degli altri tavoli restano nella sessione condivisa di partenza
  if (oldSessionId != null) {
    for (const call of db.calls) {
      if (call.token === token && call.sessionId === oldSessionId) call.sessionId = id;
    }
    for (const order of db.orders) {
      if (order.token === token && order.sessionId === oldSessionId) order.sessionId = id;
    }
  }

  save(db);
  return id;
}

/** Chiude una sessione (conto pagato) e libera tutti i token collegati. */
function closeSession(sessionId) {
  const db = load();
  const session = db.sessions[sessionId];
  if (!session) {
    const err = new Error("Sessione sconosciuta: " + sessionId);
    err.code = "UNKNOWN_SESSION";
    throw err;
  }
  session.status = "closed";
  session.closedAt = Date.now();
  for (const t of Object.keys(db.tokens)) {
    if (db.tokens[t].sessionId === Number(sessionId)) {
      db.tokens[t].sessionId = null;
    }
  }
  save(db);
}

function markCallDone(callId) {
  const db = load();
  const call = db.calls.find((c) => c.id === Number(callId));
  if (call) call.status = "done";
  save(db);
  return call;
}

function markOrderStatus(orderId, status) {
  const db = load();
  const order = db.orders.find((o) => o.id === Number(orderId));
  if (order) order.status = status;
  save(db);
  return order;
}

/** Vista aggregata per la dashboard: una riga per ogni sessione aperta, con i suoi tavoli, chiamate e ordini pendenti. */
function getState() {
  const db = load();
  const sessions = [];

  for (const [idStr, session] of Object.entries(db.sessions)) {
    if (session.status !== "open") continue;
    const id = Number(idStr);

    const tables = Object.entries(db.tokens)
      .filter(([, t]) => t.sessionId === id)
      .map(([token, t]) => ({ token, table: t.table }));

    const pendingCalls = db.calls.filter((c) => c.sessionId === id && c.status === "pending");
    const pendingOrders = db.orders.filter((o) => o.sessionId === id && o.status !== "done");

    // mostriamo solo sessioni ancora "vive": hanno un tavolo agganciato,
    // oppure hanno ancora qualcosa di pendente da smaltire
    if (tables.length === 0 && pendingCalls.length === 0 && pendingOrders.length === 0) continue;

    sessions.push({
      sessionId: id,
      createdAt: session.createdAt,
      tables,
      pendingCalls,
      pendingOrders,
    });
  }

  sessions.sort((a, b) => a.createdAt - b.createdAt);
  return sessions;
}

function listTokens() {
  const db = load();
  return db.tokens;
}

/* ---------------------------- MENU ---------------------------- */
// Struttura: { categories: [ { id, name_it, name_en, desc_it, desc_en,
//              dishes: [ { id, name_it, name_en, info_it, info_en, price } ] } ] }
// 'price' è sempre un numero (euro), mai una stringa formattata.

function defaultMenu() {
  return {
    categories: [
      {
        id: "caffetteria",
        name_it: "Caffetteria",
        name_en: "Coffee",
        desc_it: "Espressi, cappuccini e specialità della casa",
        desc_en: "Espresso, cappuccino and house specialties",
        dishes: [
          { id: "espresso", name_it: "Espresso", name_en: "Espresso", info_it: "La nostra miscela storica, tostata artigianalmente", info_en: "Our house blend, artisan roasted", price: 1.20 },
          { id: "cappuccino", name_it: "Cappuccino", name_en: "Cappuccino", info_it: "Schiuma vellutata e cacao in polvere", info_en: "Velvety foam with a dusting of cocoa", price: 1.80 },
          { id: "caffe-del-teatro", name_it: "Caffè del Teatro", name_en: "Caffè del Teatro", info_it: "La nostra ricetta speciale, panna e scorza d'arancia", info_en: "Our signature recipe, cream and orange zest", price: 3.50 },
          { id: "cioccolata-calda", name_it: "Cioccolata calda", name_en: "Hot chocolate", info_it: "Densa, servita con panna a parte", info_en: "Rich and thick, cream served on the side", price: 3.00 },
          { id: "te-infusi", name_it: "Tè e infusi", name_en: "Tea & infusions", info_it: "Selezione di foglie sfuse", info_en: "A selection of loose leaf teas", price: 2.50 },
        ],
      },
      {
        id: "drink",
        name_it: "Drink",
        name_en: "Drinks",
        desc_it: "Analcolici, aperitivi e cocktail",
        desc_en: "Soft drinks, aperitivo and cocktails",
        dishes: [
          { id: "spritz-aperol", name_it: "Spritz Aperol", name_en: "Aperol Spritz", info_it: "Aperol, prosecco e una fetta d'arancia", info_en: "Aperol, prosecco and a slice of orange", price: 6.00 },
          { id: "spritz-campari", name_it: "Spritz Campari", name_en: "Campari Spritz", info_it: "Campari, prosecco e una fetta d'arancia", info_en: "Campari, prosecco and a slice of orange", price: 6.00 },
          { id: "negroni", name_it: "Negroni", name_en: "Negroni", info_it: "Gin, vermouth rosso, bitter campari", info_en: "Gin, sweet vermouth, Campari bitter", price: 7.00 },
          { id: "gin-tonic", name_it: "Gin Tonic", name_en: "Gin & Tonic", info_it: "Gin, acqua tonica, botanici a scelta", info_en: "Gin, tonic water, choice of botanicals", price: 7.00 },
          { id: "old-fashioned", name_it: "Old Fashioned", name_en: "Old Fashioned", info_it: "Bourbon, zucchero, angostura", info_en: "Bourbon, sugar, angostura bitters", price: 8.00 },
          { id: "hugo", name_it: "Hugo", name_en: "Hugo", info_it: "Prosecco, sciroppo di sambuco, menta", info_en: "Prosecco, elderflower syrup, mint", price: 6.50 },
          { id: "americano", name_it: "Americano", name_en: "Americano", info_it: "Bitter campari, vermouth rosso, soda", info_en: "Campari bitter, sweet vermouth, soda", price: 6.00 },
          { id: "vodka-tonic", name_it: "Vodka Tonic", name_en: "Vodka Tonic", info_it: "Vodka e acqua tonica", info_en: "Vodka and tonic water", price: 6.00 },
          { id: "vodka-redbull", name_it: "Vodka Redbull", name_en: "Vodka Red Bull", info_it: "Vodka ed energy drink", info_en: "Vodka and energy drink", price: 7.00 },
          { id: "vino-bianco", name_it: "Vino bianco", name_en: "White wine", info_it: "Calice della casa", info_en: "House glass", price: 4.00 },
        ],
      },
      {
        id: "dolci",
        name_it: "Dolci",
        name_en: "Sweets",
        desc_it: "Cornetti, torte e piccola pasticceria",
        desc_en: "Pastries, cakes and sweet treats",
        dishes: [
          { id: "cornetto", name_it: "Cornetto", name_en: "Croissant", info_it: "Sfogliato, vuoto o farcito", info_en: "Flaky pastry, plain or filled", price: 1.50 },
          { id: "tiramisu", name_it: "Tiramisù", name_en: "Tiramisù", info_it: "Ricetta della casa", info_en: "Made in-house", price: 4.50 },
          { id: "torta-della-casa", name_it: "Torta della casa", name_en: "House cake", info_it: "Cambia ogni giorno, chiedete al banco", info_en: "Changes daily, ask at the counter", price: 4.00 },
          { id: "biscotteria", name_it: "Biscotteria", name_en: "Biscuits", info_it: "Selezione artigianale", info_en: "Artisan selection", price: 2.50 },
        ],
      },
      {
        id: "salati",
        name_it: "Salati",
        name_en: "Savoury",
        desc_it: "Toast, tramezzini e stuzzichini",
        desc_en: "Toasts, sandwiches and light bites",
        dishes: [
          { id: "toast", name_it: "Toast", name_en: "Toasted sandwich", info_it: "Prosciutto e formaggio", info_en: "Ham and cheese", price: 3.50 },
          { id: "tramezzino", name_it: "Tramezzino", name_en: "Tramezzino", info_it: "Pane morbido, farciture del giorno", info_en: "Soft bread, filling of the day", price: 3.00 },
          { id: "focaccia", name_it: "Focaccia", name_en: "Focaccia", info_it: "Farcita, tagliata al momento", info_en: "Filled, cut to order", price: 3.50 },
          { id: "quiche", name_it: "Quiche", name_en: "Quiche", info_it: "Verdure di stagione", info_en: "Seasonal vegetables", price: 4.00 },
        ],
      },
    ],
  };
}

function getMenu() {
  const db = load();
  if (!db.menu) {
    db.menu = defaultMenu();
    save(db);
  }
  return db.menu;
}

function saveMenu(menu) {
  const db = load();
  db.menu = menu;
  save(db);
  return db.menu;
}

module.exports = {
  ensureToken,
  addTable,
  deleteTable,
  addCall,
  addOrder,
  mergeTokens,
  splitToken,
  closeSession,
  markCallDone,
  markOrderStatus,
  getState,
  listTokens,
  getMenu,
  saveMenu,
  getSettings,
  saveSettings,
};
