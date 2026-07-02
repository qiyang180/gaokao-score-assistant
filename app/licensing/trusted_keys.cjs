const fs = require('node:fs');
const path = require('node:path');

function loadTrustedKeys(keysDir = path.join(__dirname, 'keys')) {
  if (!fs.existsSync(keysDir)) {
    return {};
  }
  return Object.fromEntries(
    fs.readdirSync(keysDir)
      .filter((name) => name.endsWith('.pem'))
      .map((name) => [
        path.basename(name, '.pem'),
        fs.readFileSync(path.join(keysDir, name), 'utf8'),
      ]),
  );
}

module.exports = {
  loadTrustedKeys,
};
