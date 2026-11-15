const knex = require('../../db/knex');
const { wendeStammdatenImportAn } = require('./importStammdaten');

// Schreibt nur Zeilen, die beim (erneuten, serverseitigen) Validieren eindeutig
// aufloesbar und keine Dublette sind. Bestehende Messwerte werden nie ueberschrieben.
// `stammdaten` (optional): vollstaendiger JSON-Export - fehlende Zaehler-
// Stammdaten werden zuerst innerhalb derselben Transaktion angelegt (siehe
// importStammdaten.js), erst danach werden die davon abhaengigen Messwerte
// (meter_id war bei der Vorschau noch null) aufgeloest und eingefuegt.
async function commitZeilen(validierteZeilen, userId, stammdaten = null) {
  const einfuegbar = validierteZeilen.filter((z) => z.aufgeloest && !z.dublette);
  let eingefuegt = 0;
  let uebersprungenOhneZuordnung = 0;
  let stammdatenErgebnis = { neueGruppen: 0, neueTypen: 0, neueZaehler: 0 };

  await knex.transaction(async (trx) => {
    let meterIdByNumber = null;
    if (stammdaten) {
      const ergebnis = await wendeStammdatenImportAn(trx, stammdaten);
      stammdatenErgebnis = { neueGruppen: ergebnis.neueGruppen, neueTypen: ergebnis.neueTypen, neueZaehler: ergebnis.neueZaehler };
      meterIdByNumber = ergebnis.meterIdByNumber;
    }

    for (const z of einfuegbar) {
      let { meter_id: meterId, meter_type_id: meterTypeId } = z.aufgeloest;
      if (meterId === null) {
        meterId = meterIdByNumber ? meterIdByNumber.get(z.zaehlernummer) : null;
        if (!meterId) { uebersprungenOhneZuordnung++; continue; }
        const meterRow = await trx('meters').where({ id: meterId }).first();
        meterTypeId = meterRow.meter_type_id;
      }
      await trx('readings').insert({ ...z.aufgeloest, meter_id: meterId, meter_type_id: meterTypeId, created_by: userId });
      eingefuegt++;
    }
  });

  return {
    eingefuegt,
    uebersprungen: validierteZeilen.length - einfuegbar.length + uebersprungenOhneZuordnung,
    ...stammdatenErgebnis,
  };
}

module.exports = { commitZeilen };
