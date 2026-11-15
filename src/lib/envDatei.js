const fs = require('fs');

// Aktualisiert/ergaenzt einzelne KEY=VALUE-Zeilen einer .env-Datei, ohne
// Kommentare oder andere Zeilen zu veraendern. Wird fuer den administrativen
// Datenbankwechsel genutzt, um DB_* gezielt zu setzen (Passwort landet nie in
// docker-compose.yml/Code, sondern ausschliesslich hier).
function quoteValue(value) {
  const v = String(value ?? '');
  if (v === '') return '';
  if (/[\s#"'\\]/.test(v)) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return v;
}

function updateEnvFile(pfad, updates) {
  let text = '';
  try {
    text = fs.readFileSync(pfad, 'utf8');
  } catch {
    text = '';
  }
  const zeilen = text.length ? text.split(/\r?\n/) : [];
  const offen = new Map(Object.entries(updates));

  const ausgabe = zeilen.map((zeile) => {
    const treffer = zeile.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (treffer && offen.has(treffer[1])) {
      const key = treffer[1];
      const wert = offen.get(key);
      offen.delete(key);
      return `${key}=${quoteValue(wert)}`;
    }
    return zeile;
  });

  while (ausgabe.length && ausgabe[ausgabe.length - 1] === '') ausgabe.pop();
  for (const [key, wert] of offen) {
    ausgabe.push(`${key}=${quoteValue(wert)}`);
  }
  ausgabe.push('');
  fs.writeFileSync(pfad, ausgabe.join('\n'), { mode: 0o600 });
}

module.exports = { updateEnvFile };
