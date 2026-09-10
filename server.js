// server.js
const path = require("path");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const store = require("./lib/store");

const app = express();
app.use(cors()); // permette al sito del cliente (altro dominio) di chiamare questa API
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Password del pannello gestore. Cambiala impostando la variabile d'ambiente
// ADMIN_PASSWORD sul servizio di hosting (Railway/Render) prima di andare live.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cambiami123";

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-password"] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Password errata" });
  }
  next();
}

function broadcastState() {
  io.emit("state", store.getState());
}

/* ------------------------- API lato cliente (sito) ------------------------- */

// Il sito legge il menu da qui per costruire le pagine (nessun contenuto
// scritto a mano nell'HTML: cambia tutto da quello che il gestore salva).
app.get("/api/menu", (req, res) => {
  res.json(store.getMenu());
});

// Il pulsante "Chiama al tavolo" del sito deve fare:
//   fetch(`${API_BASE}/api/call`, { method: "POST", headers: {"Content-Type":"application/json"},
//     body: JSON.stringify({ token }) })
app.post("/api/call", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token mancante" });
  try {
    const call = store.addCall(token);
    broadcastState();
    res.json({ ok: true, call });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Il flusso ordini dal menu deve fare:
//   fetch(`${API_BASE}/api/order`, { method: "POST", ...,
//     body: JSON.stringify({ token, items: [{name:"Espresso", qty:2}], note: "" }) })
app.post("/api/order", (req, res) => {
  const { token, items, note } = req.body;
  if (!token) return res.status(400).json({ error: "token mancante" });
  try {
    const order = store.addOrder(token, items, note);
    broadcastState();
    res.json({ ok: true, order });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/* ------------------------- API pannello gestore (menu) ------------------------- */

// Login: il pannello chiama questo endpoint solo per verificare la password
// inserita, senza salvare nulla.
app.post("/api/admin/login", requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// Salva l'intero menu (categorie + voci) in un colpo solo: il pannello
// gestore lavora tutto lato browser e invia il risultato finale qui.
app.put("/api/admin/menu", requireAdmin, (req, res) => {
  const menu = store.saveMenu(req.body);
  res.json({ ok: true, menu });
});

/* ------------------- API pannello gestore (tavoli e QR) ------------------- */
// Pensate per essere usate dal proprietario del locale senza terminale:
// aggiungere un tavolo, vederne subito il QR, eliminarlo se non serve più.

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json(store.getSettings());
});

app.put("/api/admin/settings", requireAdmin, (req, res) => {
  const settings = store.saveSettings(req.body);
  res.json({ ok: true, settings });
});

app.get("/api/admin/tables", requireAdmin, (req, res) => {
  res.json(store.listTokens());
});

app.post("/api/admin/tables", requireAdmin, (req, res) => {
  const { table } = req.body;
  if (!table || !table.trim()) {
    return res.status(400).json({ error: "Nome tavolo mancante" });
  }
  const created = store.addTable(table.trim());
  res.json({ ok: true, ...created });
});

app.delete("/api/admin/tables/:token", requireAdmin, (req, res) => {
  store.deleteTable(req.params.token);
  res.json({ ok: true });
});

// Genera l'immagine QR (PNG) per un tavolo, pronta da stampare o scaricare.
// L'URL codificato è  <siteUrl salvato nelle impostazioni>?t=<token>
app.get("/api/admin/tables/:token/qr.png", requireAdmin, async (req, res) => {
  const { siteUrl } = store.getSettings();
  if (!siteUrl) {
    return res.status(400).json({ error: "Imposta prima l'indirizzo del sito nelle Impostazioni" });
  }
  const url = `${siteUrl.replace(/\/$/, "")}?t=${req.params.token}`;
  try {
    const buffer = await QRCode.toBuffer(url, { width: 480, margin: 2 });
    res.set("Content-Type", "image/png");
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "Errore nella generazione del QR" });
  }
});

/* ------------------------- API lato bancone (staff) ------------------------- */

app.get("/api/staff/state", (req, res) => {
  res.json(store.getState());
});

app.get("/api/staff/tokens", (req, res) => {
  res.json(store.listTokens());
});

app.post("/api/staff/merge", (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || tokens.length < 2) {
    return res.status(400).json({ error: "servono almeno 2 token da unire" });
  }
  try {
    const sessionId = store.mergeTokens(tokens);
    broadcastState();
    res.json({ ok: true, sessionId });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/api/staff/split", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token mancante" });
  try {
    const sessionId = store.splitToken(token);
    broadcastState();
    res.json({ ok: true, sessionId });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/api/staff/close", (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId mancante" });
  try {
    store.closeSession(sessionId);
    broadcastState();
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/api/staff/call/:id/done", (req, res) => {
  store.markCallDone(req.params.id);
  broadcastState();
  res.json({ ok: true });
});

app.post("/api/staff/order/:id/status", (req, res) => {
  const { status } = req.body;
  store.markOrderStatus(req.params.id, status || "done");
  broadcastState();
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  // appena la dashboard si collega, le mandiamo subito lo stato attuale
  socket.emit("state", store.getState());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT}`);
  console.log(`Dashboard bancone: http://localhost:${PORT}/dashboard.html`);
});
