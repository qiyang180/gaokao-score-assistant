const fs = require('node:fs');
const path = require('node:path');

class LicenseStorage {
  constructor({ filePath, safeStorage }) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
  }

  read() {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用');
    }
    const encrypted = fs.readFileSync(this.filePath);
    return JSON.parse(this.safeStorage.decryptString(encrypted));
  }

  write(record) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用');
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = this.safeStorage.encryptString(JSON.stringify(record));
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, encrypted);
    fs.renameSync(tempPath, this.filePath);
  }

  remove() {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }
}

module.exports = {
  LicenseStorage,
};
