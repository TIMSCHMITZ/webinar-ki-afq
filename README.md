# Folien-Arbeitsplatz „KI ist Chefsache"

Gemeinsamer Arbeitsplatz für das Foliendeck zum Webinar am **02.09.2026**
(Stefanie Sonntag & Tim Schmitz). Tim und Steffi sehen dieselben Folien und
schreiben Anmerkungen direkt an die jeweilige Folie — beide sehen sofort, was
die andere Person notiert hat.

## Wie es aufgebaut ist

- **`public/deck.enc`** — die Präsentation, AES-256-GCM-verschlüsselt.
  Im Repo steht **kein Klartext**: weder Skript noch Preise noch das Passwort.
  Entschlüsselt wird ausschließlich im Browser, mit dem Passwort.
- **`server.mjs`** — reines Node (ESM), keine Dependencies, kein Build.
  Prüft das Passwort serverseitig, verwaltet die Sitzung und speichert die
  Anmerkungen.
- **`public/index.html`** — Anmeldung, Folien-Rahmen und Anmerkungsleiste.

Zwei Schichten also: Der Server gibt ohne Anmeldung gar nichts heraus, und
selbst wer an `deck.enc` käme, hätte ohne Passwort nur Zufallsbytes.

## Daten

| Was | Wo |
|---|---|
| Anmerkungen | `$DATA_DIR/anmerkungen.json` (Coolify-Volume `/data`) |
| Sitzungs-Geheimnis | `$DATA_DIR/session-secret` (wird beim ersten Start erzeugt) |

Beides liegt auf dem Volume, nicht im Image — ein Redeploy verliert nichts.

## Umgebungsvariablen

| Variable | Zweck |
|---|---|
| `APP_PASSWORT_HASH` | **Pflicht.** Format `<salt-hex>:<hash-hex>` (scrypt). Fehlt sie, startet die App bewusst nicht. |
| `DATA_DIR` | Ablage, Vorgabe `/data` |
| `PORT` | Vorgabe `3000` |

Hash erzeugen:

```bash
node server.mjs --hash "DeinPasswort"
```

## Folien aktualisieren

Die Quelle des Decks liegt im Hauptrepo unter
`clients/schmitz-systemarchitektur/webinar/praesentation/index.html`.
Nach jeder Änderung dort:

```bash
node clients/schmitz-systemarchitektur/webinar/praesentation/veroeffentliche.mjs "<Passwort>"
cd /Users/stim/webinar-ki-afq && git add -A && git commit -m "Folien aktualisiert" && git push
# danach in Coolify neu deployen
```

Das Skript verschlüsselt neu, kopiert Bilder und Schriften mit und bricht ab,
falls versehentlich Klartext im Ergebnis landet.

## Bedienung

Pfeiltasten oder Klick blättern. `n` Sprechernotizen, `t` Timer gegen den
Soll-Minutenplan, `f` Vollbild. In der Leiste rechts hängt jede Anmerkung an der
Folie, auf der sie geschrieben wurde; ein Klick auf „Folie 12" springt dorthin.
