# Vorbereitung für Unraid Community Applications (CA)

Status: **strukturelle Vorbereitung, nicht veröffentlicht.** Dieses Dokument beschreibt,
was für eine spätere, separat zu beauftragende Veröffentlichung als Unraid-CA-App
noch zu tun ist. Es wurde nichts hochgeladen, gebaut oder veröffentlicht.

## Produktname

Die App zeigt sich seit diesem Auftrag unter dem vorläufigen, konfigurierbaren
Anzeigenamen **„Zählwerk“** (Umgebungsvariable `PRODUCT_NAME`, Standard
„Zählwerk“ - siehe `src/config.js`). Das ist reine Anzeige (Titel, Kopfzeile,
E-Mail-Betreffs); der technische AppFactory-Projekt-Slug
(`zaehlerstandsermittlung-1`: Ordner, Compose-Service, Datenbankname) bleibt
davon **unberührt** und wird nicht umbenannt. Es wurde keine Marken- oder
Namensverfügbarkeit geprüft.

## Aktueller Testbetrieb vs. für CA benötigtes Image

Im AppFactory-Testbetrieb läuft die App nach AppFactory-Konvention über das
Basis-Image `node:20` mit eingebundenem Projektordner; `npm install` läuft bei
jedem Containerstart (`docker-compose.yml`). Das ist für die AppFactory-
Testumgebung richtig und wird **nicht geändert**.

Für eine echte Unraid-CA-Veröffentlichung braucht es stattdessen ein
**selbstständiges, vorab gebautes Image** (kein Bind-Mount des Quellcodes, kein
`npm install` beim Start). Dafür liegt bereits ein `Dockerfile` bereit
(Node 20, `npm ci --omit=dev`, Port 3008, Volume `/app/data`) - es wird vom
aktuellen `docker-compose.yml` bewusst noch nicht verwendet.

## Noch ausstehende Schritte (nicht Teil dieses Auftrags)

1. **Image bauen und veröffentlichen:** z. B. über die im AppFactory-Betrieb
   vorhandene Gitea-Instanz (Repository + Actions-Pipeline oder manueller
   Build) und einer öffentlich erreichbaren Container-Registry (Docker Hub,
   GitHub Container Registry o. ä.). Versionierung über Tags empfohlen.
2. **Icon:** ein quadratisches PNG/SVG-Icon für die CA-Kachel erzeugen und
   hosten (z. B. im selben Repository über eine Raw-URL).
3. **CA-Vorlage (XML):** eine Unraid-Container-Vorlage mit Repository-Pfad,
   Icon-URL, `WebUI`-Pfad (`http://[IP]:[PORT:3008]/`), Port- und Volume-
   Zuordnung (`/app/data` → Appdata-Pfad) sowie den unten genannten
   Umgebungsvariablen erstellen. Eine unausgefüllte Beispielstruktur:

   ```xml
   <Container version="2">
     <Name>zaehlwerk</Name>
     <Repository>REGISTRY/NUTZER/zaehlwerk:TAG</Repository>
     <Registry>https://REGISTRY/</Registry>
     <WebUI>http://[IP]:[PORT:3008]/</WebUI>
     <Icon>https://.../icon.png</Icon>
     <Overview>Erfassung und Auswertung von Zählerständen (Zählwerk).</Overview>
     <Config Name="WebUI-Port" Target="3008" Default="3008" Mode="tcp" Type="Port" />
     <Config Name="Daten" Target="/app/data" Default="/mnt/user/appdata/zaehlwerk" Mode="rw" Type="Path" />
     <Config Name="DB_DRIVER" Target="DB_DRIVER" Default="sqlite" Type="Variable" />
     <Config Name="ADMIN_INITIAL_EMAIL" Target="ADMIN_INITIAL_EMAIL" Default="admin@local" Type="Variable" />
     <Config Name="PRODUCT_NAME" Target="PRODUCT_NAME" Default="Zählwerk" Type="Variable" />
   </Container>
   ```

4. **Einreichung:** Pull Request in das offizielle CA-Template-Repository
   (`Squidly271/community.applications` bzw. dessen Nachfolger) gemäß den dort
   dokumentierten Regeln - **nicht Teil dieses Auftrags.**
5. **Dokumentation:** kurze Maintainer-Hinweise (unten) vor der Einreichung
   final prüfen; README weiterhin als ausführliche Nutzerdokumentation
   beibehalten.

## Umgebungsvariablen (Kurzüberblick für die Vorlage)

Siehe README-Abschnitt „Ersteinrichtung“ für die vollständige Liste. Für eine
CA-Vorlage am wichtigsten: `DB_DRIVER`, `DB_HOST`/`DB_PORT`/`DB_USER`/
`DB_PASSWORD`/`DB_NAME` (nur bei MariaDB), `ADMIN_INITIAL_EMAIL`,
`ADMIN_INITIAL_PASSWORD` (leer lassen für automatische Zufallserzeugung mit
einmaliger Ausgabe in den Container-Logs), `PRODUCT_NAME`.

## Persistenter Datenpfad

`/app/data` enthält bei SQLite die Datenbankdatei, bei jedem Treiber zusätzlich
`secrets.json`, hochgeladene Fotos (`uploads/`), die Original-Excel-Vorlage
(`vorlagen/`) und Exporte (`exports/`) - muss in Unraid auf einen persistenten
Appdata-Pfad gemappt werden (siehe `VOLUME` im `Dockerfile`).
