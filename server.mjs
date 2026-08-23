#!/usr/bin/env node
// Folien-Arbeitsplatz „KI ist Chefsache" (Webinar 02.09.2026).
//
// Zweck: Tim und Steffi arbeiten gemeinsam am Foliendeck. Die Praesentation liegt
// AES-verschluesselt als public/deck.enc im Repo; entschluesselt wird sie erst im
// Browser mit dem Passwort. Anmerkungen liegen serverseitig und sind fuer beide
// sofort sichtbar.
//
// Reines Node (ESM), keine Dependencies, kein Build — wie der Rest des Systems.
// Persistenz: eine JSON-Datei auf dem Coolify-Volume (bei zwei Personen reicht das;
// jeder Schreibvorgang geht ueber tmp + rename, damit die Datei nie halb geschrieben
// auf der Platte liegt).
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = dirname(fileURLToPath(import.meta.url));
const OEFFENTLICH = join(HIER, "public");
const DATEN = process.env.DATA_DIR || "/data";
const PORT = Number(process.env.PORT || 3000);

// --- Passwort ---------------------------------------------------------
// Der Hash kommt aus der Umgebung (in Coolify gesetzt), damit im oeffentlichen
// Repo weder Passwort noch Hash steht. Fehlt er, startet die App bewusst NICHT —
// eine offene Seite waere schlimmer als eine, die nicht laeuft.
// Hilfsaufruf zum Erzeugen des Hashes: node server.mjs --hash "Passwort"
// Steht bewusst VOR der Pflichtpruefung — sonst liesse er sich nie aufrufen.
if (process.argv[2] === "--hash") {
  const salt = randomBytes(16);
  const h = scryptSync(process.argv[3] || "", salt, 32, { N: 16384, r: 8, p: 1 });
  console.log(`${salt.toString("hex")}:${h.toString("hex")}`);
  process.exit(0);
}

const PW_HASH = (process.env.APP_PASSWORT_HASH || "").trim();
if (!PW_HASH || !PW_HASH.includes(":")) {
  console.error("✗ APP_PASSWORT_HASH fehlt oder hat nicht das Format <salt-hex>:<hash-hex>.");
  console.error("  Erzeugen mit:  node server.mjs --hash 'DeinPasswort'");
  process.exit(1);
}

function passwortStimmt(eingabe) {
  const [saltHex, hashHex] = PW_HASH.split(":");
  const soll = Buffer.from(hashHex, "hex");
  const ist = scryptSync(String(eingabe || ""), Buffer.from(saltHex, "hex"), soll.length, { N: 16384, r: 8, p: 1 });
  return ist.length === soll.length && timingSafeEqual(ist, soll);
}

// --- Sitzungen (signiertes Cookie, kein Server-State) ------------------
if (!existsSync(DATEN)) mkdirSync(DATEN, { recursive: true });
const SECRET_DATEI = join(DATEN, "session-secret");
if (!existsSync(SECRET_DATEI)) writeFileSync(SECRET_DATEI, randomBytes(32).toString("hex"), { mode: 0o600 });
const SECRET = readFileSync(SECRET_DATEI, "utf8").trim();
const SITZUNGSDAUER = 30 * 24 * 3600 * 1000; // 30 Tage — es sind zwei bekannte Personen

const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url").toString("utf8");
const signiere = (nutzlast) => {
  const p = b64u(JSON.stringify(nutzlast));
  return `${p}.${createHmac("sha256", SECRET).update(p).digest("base64url")}`;
};
function pruefeToken(token) {
  if (!token || !token.includes(".")) return null;
  const [p, sig] = token.split(".");
  const soll = createHmac("sha256", SECRET).update(p).digest("base64url");
  if (sig.length !== soll.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(soll))) return null;
  try {
    const d = JSON.parse(unb64u(p));
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}
const sitzung = (req) => {
  const roh = req.headers.cookie || "";
  const treffer = roh.split(";").map((c) => c.trim()).find((c) => c.startsWith("sid="));
  return treffer ? pruefeToken(decodeURIComponent(treffer.slice(4))) : null;
};

// --- Anmerkungen -------------------------------------------------------
const NOTIZEN = join(DATEN, "anmerkungen.json");
function ladeNotizen() {
  if (!existsSync(NOTIZEN)) return [];
  try { return JSON.parse(readFileSync(NOTIZEN, "utf8")); } catch { return []; }
}
function speichereNotizen(liste) {
  const tmp = NOTIZEN + ".tmp";
  writeFileSync(tmp, JSON.stringify(liste, null, 2));
  renameSync(tmp, NOTIZEN); // atomar: nie eine halb geschriebene Datei
}

// --- Textaenderungen ---------------------------------------------------
// Die Praesentation selbst liegt verschluesselt; der Server kann sie also gar
// nicht anfassen. Aenderungen werden deshalb als Auflage gespeichert: je Folie
// ein Feldpfad ("h", "list.0", "cards.1.p") mit dem neuen Wert. Der Browser
// legt sie nach dem Entschluesseln ueber das Deck. Das Original bleibt
// unangetastet — jede Aenderung ist einzeln ruecknehmbar.
const AENDERUNGEN = join(DATEN, "aenderungen.json");
function ladeAenderungen() {
  if (!existsSync(AENDERUNGEN)) return {};
  try { return JSON.parse(readFileSync(AENDERUNGEN, "utf8")); } catch { return {}; }
}
function speichereAenderungen(obj) {
  const tmp = AENDERUNGEN + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, AENDERUNGEN);
}
// Nur einfache Feldpfade zulassen — kein __proto__, keine Tiefe ohne Ende.
const PFAD_OK = /^[a-zA-Z]{1,20}(\.(0|[1-9][0-9]?)|\.[a-zA-Z]{1,20}){0,3}$/;

// --- HTTP-Hilfen -------------------------------------------------------
const TYPEN = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".enc": "application/octet-stream",
  ".ico": "image/x-icon",
};
function json(res, code, daten, kopf = {}) {
  const koerper = JSON.stringify(daten);
  res.writeHead(code, { "content-type": TYPEN[".json"], "cache-control": "no-store", ...kopf });
  res.end(koerper);
}
function koerperLesen(req, maxBytes = 64 * 1024) {
  return new Promise((fertig, fehler) => {
    let roh = "", zuViel = false;
    req.on("data", (d) => {
      roh += d;
      if (roh.length > maxBytes) { zuViel = true; req.destroy(); }
    });
    req.on("end", () => { if (zuViel) return fehler(new Error("zu gross")); try { fertig(JSON.parse(roh || "{}")); } catch { fertig({}); } });
    req.on("error", fehler);
  });
}

// --- Server ------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const pfad = decodeURIComponent(url.pathname);
  const s = sitzung(req);

  // Die Startseite ist immer erreichbar — sie enthaelt das Login-Formular.
  if (pfad === "/" || pfad === "/index.html") {
    const html = readFileSync(join(OEFFENTLICH, "index.html"));
    res.writeHead(200, { "content-type": TYPEN[".html"], "cache-control": "no-cache" });
    return res.end(html);
  }

  // --- Anmeldung ---
  if (pfad === "/api/login" && req.method === "POST") {
    const { passwort, name } = await koerperLesen(req);
    // Kurze Verzoegerung gegen stupides Durchprobieren.
    await new Promise((r) => setTimeout(r, 400));
    if (!passwortStimmt(passwort)) return json(res, 401, { fehler: "Passwort stimmt nicht." });
    const wer = String(name || "").trim().slice(0, 40) || "Gast";
    const token = signiere({ name: wer, exp: Date.now() + SITZUNGSDAUER });
    return json(res, 200, { name: wer }, {
      "set-cookie": `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SITZUNGSDAUER / 1000}; Secure`,
    });
  }
  if (pfad === "/api/logout" && req.method === "POST") {
    return json(res, 200, { ok: true }, { "set-cookie": "sid=; Path=/; HttpOnly; Max-Age=0; Secure" });
  }
  if (pfad === "/api/session") {
    return s ? json(res, 200, { name: s.name }) : json(res, 401, { fehler: "nicht angemeldet" });
  }

  // --- Ab hier ist eine Sitzung Pflicht ---
  if (!s) return json(res, 401, { fehler: "nicht angemeldet" });

  // --- Anmerkungen ---
  if (pfad === "/api/notes") {
    if (req.method === "GET") return json(res, 200, { notizen: ladeNotizen(), ich: s.name });
    if (req.method === "POST") {
      const { folie, text } = await koerperLesen(req);
      const inhalt = String(text || "").trim().slice(0, 4000);
      const nr = Number(folie);
      if (!inhalt) return json(res, 400, { fehler: "Text fehlt." });
      if (!Number.isInteger(nr) || nr < 1 || nr > 999) return json(res, 400, { fehler: "Foliennummer ungueltig." });
      const liste = ladeNotizen();
      const neu = { id: randomUUID(), folie: nr, autor: s.name, text: inhalt, ts: Date.now(), erledigt: false };
      liste.push(neu);
      speichereNotizen(liste);
      return json(res, 201, { notiz: neu });
    }
  }
  const treffer = pfad.match(/^\/api\/notes\/([0-9a-f-]{36})$/);
  if (treffer) {
    const liste = ladeNotizen();
    const i = liste.findIndex((n) => n.id === treffer[1]);
    if (i < 0) return json(res, 404, { fehler: "nicht gefunden" });
    if (req.method === "DELETE") {
      const [weg] = liste.splice(i, 1);
      speichereNotizen(liste);
      return json(res, 200, { geloescht: weg.id });
    }
    if (req.method === "PATCH") {
      const { text, erledigt } = await koerperLesen(req);
      if (typeof text === "string" && text.trim()) liste[i].text = text.trim().slice(0, 4000);
      if (typeof erledigt === "boolean") liste[i].erledigt = erledigt;
      liste[i].geaendert = Date.now();
      speichereNotizen(liste);
      return json(res, 200, { notiz: liste[i] });
    }
  }

  // --- Textaenderungen am Deck ---
  if (pfad === "/api/edits") {
    if (req.method === "GET") return json(res, 200, { aenderungen: ladeAenderungen() });
    if (req.method === "PUT") {
      const { folie, feld, wert } = await koerperLesen(req, 256 * 1024);
      const nr = Number(folie);
      if (!Number.isInteger(nr) || nr < 1 || nr > 999) return json(res, 400, { fehler: "Foliennummer ungueltig." });
      if (typeof feld !== "string" || !PFAD_OK.test(feld)) return json(res, 400, { fehler: "Feldpfad ungueltig." });
      if (typeof wert !== "string" || wert.length > 5000) return json(res, 400, { fehler: "Wert fehlt oder ist zu lang." });
      const alle = ladeAenderungen();
      const f = (alle[nr] ||= {});
      f[feld] = { wert, autor: s.name, ts: Date.now() };
      speichereAenderungen(alle);
      return json(res, 200, { folie: nr, feld, gespeichert: f[feld] });
    }
    if (req.method === "DELETE") {
      const { folie, feld } = await koerperLesen(req);
      const alle = ladeAenderungen();
      const nr = String(Number(folie));
      if (alle[nr] && feld in alle[nr]) {
        delete alle[nr][feld];
        if (!Object.keys(alle[nr]).length) delete alle[nr];
        speichereAenderungen(alle);
      }
      return json(res, 200, { zurueckgesetzt: true });
    }
  }

  // --- Statische Dateien (nur angemeldet) ---
  const sicher = normalize(pfad).replace(/^(\.\.[/\\])+/, "");
  const datei = join(OEFFENTLICH, sicher);
  if (!datei.startsWith(OEFFENTLICH) || !existsSync(datei)) {
    return json(res, 404, { fehler: "nicht gefunden" });
  }
  const typ = TYPEN[extname(datei).toLowerCase()] || "application/octet-stream";
  // Das verschluesselte Deck nie zwischenspeichern, Bilder und Schriften gern lange.
  const cache = datei.endsWith(".enc") ? "no-store" : "public, max-age=604800";
  res.writeHead(200, { "content-type": typ, "cache-control": cache });
  res.end(readFileSync(datei));
});

server.listen(PORT, () => console.log(`Folien-Arbeitsplatz laeuft auf :${PORT} (Daten in ${DATEN})`));
