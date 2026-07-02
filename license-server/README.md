# 授权服务器部署与使用

授权服务器负责生成激活码、绑定设备、签发 Ed25519 许可证、刷新在线授权和签发离线许可证。它不会接收学生表或成绩数据。

## 本地联调

在仓库根目录首次生成签名密钥：

```powershell
npm run license:keygen
```

私钥和口令保存在被 Git 忽略的 `.license-secrets/`，公钥写入桌面客户端。私钥和口令必须分别备份，丢失后将无法继续签发兼容旧安装包的许可证。

安装并初始化服务端：

```powershell
cd license-server
npm install
npm run setup:local
npm start
```

管理员地址为 `http://127.0.0.1:8787/admin/`。随机管理员密码保存在被忽略的 `.local-admin-password.txt`。本地数据库位于 `data/licenses.sqlite`。

## Linux VPS 与 Docker

1. 为授权服务准备域名，并将 DNS 指向 VPS。
2. 复制 `license-server/.env.example` 为 `license-server/.env`。
3. 设置 `LICENSE_DOMAIN`、随机 `ACTIVATION_KEY_PEPPER` 和管理员密码哈希。
4. 把私钥和口令分别放到：

```text
license-server/secrets/license-private.pem
license-server/secrets/license-passphrase.txt
```

管理员密码哈希可在本地生成：

```powershell
npm --prefix license-server run hash-password -- "至少十位的管理员密码"
```

启动服务：

```bash
cd license-server
docker compose up -d --build
```

Caddy 会为 `LICENSE_DOMAIN` 自动申请 HTTPS 证书。生产环境禁止通过公网 HTTP 连接授权 API。

## 正式客户端构建

构建时把公网授权地址写入安装包：

```powershell
$env:GAOKAO_LICENSE_API_URL = "https://license.example.com"
npm run dist:win
```

没有代码签名证书时使用 `dist:win`。配置 `CSC_LINK`、`CSC_KEY_PASSWORD` 等 electron-builder 证书变量后，可使用：

```powershell
npm run dist:win:signed
```

## 日常授权流程

在线授权：

1. 登录 `/admin/`。
2. 输入客户名称和到期日，生成激活码。
3. 激活码只完整显示一次，应立即交付并妥善保存。
4. 客户在软件授权页输入激活码。
5. 同一码只能绑定一台设备；原设备可以重复激活。
6. 更换电脑前，在后台点击“解绑”。

离线授权：

1. 客户在软件授权页点击“导出申请”，得到 `.gkreq`。
2. 管理员在“离线签发”页面导入申请并选择激活码。
3. 后台下载 `.gklic`，交给客户导入。
4. 离线许可证到期前不能远程吊销；必须谨慎设置到期日。

## 备份

必须备份以下内容：

- `.license-secrets/prod-2026-01-private.pem`
- `.license-secrets/prod-2026-01-passphrase.txt`
- Docker `license-data` 卷或 `data/licenses.sqlite`
- 生产环境变量中的 `ACTIVATION_KEY_PEPPER`

不要把私钥、口令、管理员密码或服务器 `.env` 提交到 Git。
