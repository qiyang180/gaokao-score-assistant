const state = {
  csrfToken: '',
  codes: [],
  offlineRequest: null,
};

const loginView = document.querySelector('#login-view');
const dashboardView = document.querySelector('#dashboard-view');
const notice = document.querySelector('#notice');

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(path, {
    ...options,
    method,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' && state.csrfToken ? { 'x-csrf-token': state.csrfToken } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `请求失败：${response.status}`);
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function showNotice(message, isError = false) {
  notice.hidden = !message;
  notice.textContent = message || '';
  notice.classList.toggle('is-error', isError);
}

function formatDate(value) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function shortDevice(value) {
  if (!value) {
    return '未绑定';
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderCodes() {
  document.querySelector('#code-count').textContent = `${state.codes.length} 条`;
  document.querySelector('#codes-body').innerHTML = state.codes.map((code) => `
    <tr>
      <td>${escapeHtml(code.customer)}</td>
      <td><code>${escapeHtml(code.keyPrefix)}...</code></td>
      <td>${formatDate(code.expiresAt)}</td>
      <td class="status status-${escapeHtml(code.status)}">${escapeHtml(code.status)}</td>
      <td title="${escapeHtml(code.deviceId || '')}"><code>${shortDevice(code.deviceId)}</code></td>
      <td>${escapeHtml(code.mode || '-')}</td>
      <td>${formatDate(code.lastActivatedAt)}</td>
      <td>
        <div class="actions">
          <button data-action="reset" data-id="${code.id}" ${code.deviceId ? '' : 'disabled'}>解绑</button>
          <button class="danger" data-action="revoke" data-id="${code.id}" ${code.status === 'revoked' ? 'disabled' : ''}>吊销</button>
        </div>
      </td>
    </tr>
  `).join('');

  const options = state.codes
    .filter((code) => code.status === 'active' && new Date(code.expiresAt) > new Date())
    .map((code) => `<option value="${code.id}">${escapeHtml(code.customer)} · ${escapeHtml(code.keyPrefix)}...</option>`)
    .join('');
  document.querySelector('#offline-code').innerHTML = options || '<option value="">没有可用激活码</option>';
}

async function loadCodes() {
  const data = await api('/admin/api/codes');
  state.codes = data.codes;
  renderCodes();
}

async function loadAudit() {
  const data = await api('/admin/api/audit?limit=100');
  document.querySelector('#audit-body').innerHTML = data.events.map((event) => `
    <tr>
      <td>${formatDate(event.createdAt)}</td>
      <td>${escapeHtml(event.event)}</td>
      <td>${escapeHtml(event.actor)}</td>
      <td><code>${escapeHtml(event.targetId || '-')}</code></td>
      <td><code>${escapeHtml(JSON.stringify(event.details))}</code></td>
    </tr>
  `).join('');
}

async function refreshAll() {
  showNotice('');
  try {
    await Promise.all([loadCodes(), loadAudit()]);
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function restoreSession() {
  try {
    const session = await api('/admin/api/session');
    state.csrfToken = session.csrfToken;
    document.querySelector('#admin-name').textContent = session.username;
    loginView.hidden = true;
    dashboardView.hidden = false;
    await refreshAll();
  } catch {
    loginView.hidden = false;
    dashboardView.hidden = true;
  }
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorNode = document.querySelector('#login-error');
  errorNode.textContent = '';
  try {
    const data = await api('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.querySelector('#username').value,
        password: document.querySelector('#password').value,
      }),
    });
    state.csrfToken = data.csrfToken;
    await restoreSession();
  } catch (error) {
    errorNode.textContent = error.message;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  await api('/admin/api/logout', { method: 'POST' }).catch(() => {});
  state.csrfToken = '';
  loginView.hidden = false;
  dashboardView.hidden = true;
});

document.querySelector('#refresh-button').addEventListener('click', refreshAll);

document.querySelector('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showNotice('');
  try {
    const expiryDate = document.querySelector('#expires-at').value;
    const expiresAt = new Date(`${expiryDate}T23:59:59+08:00`).toISOString();
    const created = await api('/admin/api/codes', {
      method: 'POST',
      body: JSON.stringify({
        customer: document.querySelector('#customer').value,
        expiresAt,
      }),
    });
    showNotice(`激活码只显示一次，请立即保存：\n${created.activationCode}`);
    document.querySelector('#customer').value = '';
    await loadCodes();
  } catch (error) {
    showNotice(error.message, true);
  }
});

document.querySelector('#codes-body').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) {
    return;
  }
  const action = button.dataset.action;
  const message = action === 'reset'
    ? '确认解绑当前设备？旧在线许可证将在刷新或宽限期结束后失效。'
    : '确认吊销此激活码？该操作不能在当前后台恢复。';
  if (!window.confirm(message)) {
    return;
  }
  try {
    await api(`/admin/api/codes/${button.dataset.id}/${action}`, { method: 'POST' });
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  }
});

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.hidden = true;
    });
    button.classList.add('active');
    document.querySelector(`#tab-${button.dataset.tab}`).hidden = false;
  });
});

document.querySelector('#request-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  state.offlineRequest = null;
  if (!file) {
    document.querySelector('#request-preview').textContent = '尚未选择申请文件';
    return;
  }
  try {
    state.offlineRequest = JSON.parse(await file.text());
    document.querySelector('#request-preview').textContent = [
      `设备码：${state.offlineRequest.deviceCode || '-'}`,
      `设备 ID：${state.offlineRequest.deviceId || '-'}`,
      `软件版本：${state.offlineRequest.appVersion || '-'}`,
      `申请时间：${formatDate(state.offlineRequest.createdAt)}`,
    ].join('\n');
  } catch {
    document.querySelector('#request-preview').textContent = '申请文件无法解析';
  }
});

document.querySelector('#offline-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.offlineRequest) {
    showNotice('请先选择有效的离线申请文件', true);
    return;
  }
  try {
    const response = await api('/admin/api/offline-license', {
      method: 'POST',
      body: JSON.stringify({
        codeId: document.querySelector('#offline-code').value,
        request: state.offlineRequest,
      }),
    });
    const blob = new Blob([JSON.stringify(response.file, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${state.offlineRequest.deviceCode || 'offline'}.gklic`;
    link.click();
    URL.revokeObjectURL(link.href);
    showNotice(`离线许可证已签发，有效期至 ${formatDate(response.payload.expiresAt)}`);
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  }
});

const defaultExpiry = new Date();
defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 1);
document.querySelector('#expires-at').value = defaultExpiry.toISOString().slice(0, 10);
restoreSession();
