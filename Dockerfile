# Eigenstaendiges Produktions-Image fuer eine spaetere Veroeffentlichung (z. B.
# Unraid Community Applications) - siehe docs/UNRAID.md fuer die noch
# ausstehenden Schritte. Wird vom AppFactory-Testbetrieb (docker-compose.yml)
# NICHT verwendet: dort laeuft die App nach AppFactory-Konvention ueber das
# Basis-Image node:20 mit eingebundenem Projektordner und "npm install" beim
# Containerstart - das bleibt bewusst unveraendert, damit der automatische
# Deploy-Ablauf der AppFactory (docker compose up -d) nicht beeintraechtigt wird.
FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=3008
EXPOSE 3008

# Persistente Daten (SQLite-Datei, Fotos, Vorlagen, Exporte, secrets.json) -
# bei Unraid als Appdata-Pfad einzubinden (siehe docs/UNRAID.md).
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
