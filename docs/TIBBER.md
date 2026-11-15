# Tibber-Integration (nur Idee, nicht Teil von Version 1)

Tibber wird in dieser Version ausdruecklich nicht integriert. Dieser Vermerk
beschreibt nur die Idee fuer eine spaetere, separat zu beauftragende Erweiterung.

## Moegliche Integrationswege

- **Tibber API (GraphQL)**: Live-Verbrauch und historische Stundenwerte fuer
  Stromzaehler koennten automatisiert als zusaetzliche Messwerte uebernommen
  werden (ergaenzend zur manuellen Ablesung, nicht als Ersatz).
- Denkbar als periodischer Hintergrundabgleich (analog zur bestehenden
  Eichfrist-Pruefung), der neue Werte als Messwerte mit Status "abgelesen" und
  einer klaren Kennzeichnung "Quelle: Tibber" anlegt.

## Vor einer Umsetzung zu klaeren

- Zugriffsart: persoenlicher Tibber-API-Token vs. OAuth; wo und wie wuerde
  dieser gespeichert (analog zu SMTP/KI: verschluesselt, nur Admin einsehbar/
  aenderbar, nie im Klartext an den Browser)?
- Welcher Zaehler/welche Zaehlerart in dieser App entspricht dem Tibber-Pulse/
  Tibber-Zaehler (vermutlich "Strom Mietwohnung" oder ein neuer Typ)?
- Rate-Limits und Kosten der Tibber-API, Umgang mit Ausfaellen (darf die App
  nie blockieren, analog zur KI-/SMTP-Anbindung).
- Datenschutz/Zustimmung: Tibber-Zugangsdaten sind personenbezogen und an den
  jeweiligen Netzanschluss gebunden.

In dieser Version gibt es dazu keine API-Aufrufe, keine Konfigurationsfelder
und keine UI-Elemente.
