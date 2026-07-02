const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const DEVICE_NAMESPACE = 'gaokao-score-agent:v1:';

function hashMachineGuid(machineGuid) {
  const normalized = String(machineGuid || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('无法读取 Windows 设备标识');
  }
  return crypto.createHash('sha256').update(`${DEVICE_NAMESPACE}${normalized}`).digest('hex');
}

function readWindowsMachineGuid() {
  if (process.platform !== 'win32') {
    throw new Error('当前授权版本仅支持 Windows 设备');
  }
  let output;
  try {
    output = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true },
    );
  } catch {
    throw new Error('无法读取 Windows MachineGuid，请确认系统注册表状态');
  }
  const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
  if (!match) {
    throw new Error('Windows MachineGuid 格式异常');
  }
  return match[1].trim();
}

function getDeviceId() {
  return hashMachineGuid(readWindowsMachineGuid());
}

function formatDeviceCode(deviceId) {
  return String(deviceId || '').slice(0, 20).toUpperCase().match(/.{1,5}/g)?.join('-') || '';
}

module.exports = {
  formatDeviceCode,
  getDeviceId,
  hashMachineGuid,
  readWindowsMachineGuid,
};
