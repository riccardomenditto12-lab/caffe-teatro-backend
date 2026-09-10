// lib/importTokens.js
//
// Importa nel backend la mappa tavolo -> token generata da
// generate_qr_codes.py (mapping.json), così i QR stampati corrispondono
// esattamente ai token conosciuti dal server.
//
// USO:
//   node lib/importTokens.js /percorso/di/mapping.json
//
// Esempio, usando l'output dello script Python di prima:
//   node lib/importTokens.js ../output/caffè-del-teatro/mapping.json

const fs = require("fs");
const path = require("path");
const store = require("./store");

const mappingPath = process.argv[2];

if (!mappingPath) {
  console.error("Uso: node lib/importTokens.js <percorso-mapping.json>");
  process.exit(1);
}

const fullPath = path.resolve(mappingPath);
const mapping = JSON.parse(fs.readFileSync(fullPath, "utf-8"));

let count = 0;
for (const [table, info] of Object.entries(mapping)) {
  store.ensureToken(info.token, table);
  count++;
}

console.log(`Importati ${count} tavoli/token da ${fullPath}`);
