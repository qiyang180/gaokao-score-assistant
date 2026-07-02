# Gaokao Score Assistant

> A Windows desktop application for batch querying, reviewing, and exporting Gaokao scores with Excel and Playwright.

![Platform](https://img.shields.io/badge/platform-Windows-0078D6)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![License](https://img.shields.io/badge/license-not%20specified-lightgrey)

高考成绩查询助手是一套面向 Windows 的本地半自动工作流，用于导入学生 Excel、辅助完成官方页面查询、保存成绩截图，并生成汇总表。验证码始终由用户本人完成，项目不提供验证码破解或绕过功能。

## 功能特性

- 导入 `.xlsx` 或 `.csv` 学生表，自动识别常见学校表头
- 校验姓名及身份证号、准考证号、考生号、报名序号等查询字段
- 通过 Playwright 自动填写查询页面，并保留人工验证码环节
- 支持暂停、继续、跳过、重试当前学生和停止任务
- 保存逐个学生的查询结果、失败记录和页面截图
- 将结果汇总为 Excel，支持复用已有成绩汇总模板
- 提供不连接真实官网的本地 Demo
- 提供 Electron GUI、Windows 安装版和免安装版构建
- 支持在线激活、设备绑定和离线许可证

## 使用边界

本项目仅适用于已获得学生、监护人或所属机构明确授权的成绩查询工作。使用者必须遵守目标网站的服务条款、访问频率限制及当地个人信息保护要求。

- 不要将真实学生数据提交到第三方服务
- 不要使用在线验证码识别或其他绕过措施
- 不要把学生表、查询结果、截图或日志提交到 Git
- 查询结束后应按所在机构的数据管理要求清理本地文件

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 桌面端 | Electron、React、Vite |
| 浏览器自动化 | Playwright |
| Excel 处理 | ExcelJS |
| 授权服务 | Node.js、Express、SQLite |
| 部署 | electron-builder、Docker Compose、Caddy |

## 环境要求

- Windows 10/11
- Node.js 18 或更高版本
- npm
- PowerShell 5.1 或 PowerShell 7

## 快速开始

### 1. 克隆并安装

```powershell
git clone https://github.com/qiyang180/gaokao-score-assistant.git
cd gaokao-score-assistant
npm install
npm run install:browsers
```

### 2. 运行本地 Demo

```powershell
npm run demo
```

Demo 只访问仓库内的 `demo/mock_query.html`，使用虚构学生信息，不连接真实成绩网站，也不需要生产许可证。

运行完成后可在 `output/demo/` 查看：

- `results.jsonl`：结构化查询结果
- `summary.xlsx`：Excel 汇总表
- `screenshots/`：每名测试学生的页面截图
- `events.jsonl`：运行事件记录
- `failed_students.csv`：失败或无成绩记录

## 启动桌面端

桌面端开发模式需要先完成本地授权服务初始化。

### 1. 生成本地开发密钥

```powershell
npm run license:keygen -- local-dev
```

公开仓库只包含生产验签公钥，不包含对应私钥。上面的命令会创建一套独立的本地开发密钥，并将被忽略的 `local-dev.pem` 加入桌面端信任目录。

该命令只应执行一次。私钥和口令保存在被 Git 忽略的 `.license-secrets/`，必须分别安全备份。

### 2. 初始化授权服务

```powershell
npm --prefix license-server install
npm --prefix license-server run setup:local
```

然后在被忽略的 `license-server/.env` 中修改以下三项：

```dotenv
LICENSE_KEY_ID=local-dev
LICENSE_PRIVATE_KEY_PATH=../.license-secrets/local-dev-private.pem
LICENSE_KEY_PASSPHRASE_FILE=../.license-secrets/local-dev-passphrase.txt
```

启动服务：

```powershell
npm run license:server
```

本地管理后台地址：

```text
http://127.0.0.1:8787/admin/
```

随机管理员密码保存在 `license-server/.local-admin-password.txt`。

### 3. 启动 GUI

保持授权服务运行，另开一个 PowerShell 窗口：

```powershell
npm run app:dev
```

在管理后台生成激活码后，即可在桌面端完成激活、导入学生表并启动查询。

## 学生表格式

可直接参考 [data/students_template.csv](data/students_template.csv)。

| 字段 | 要求 |
| --- | --- |
| `班级` | 可选 |
| `姓名` | 必填 |
| `身份证号` | 与下列查询号码至少填写一项 |
| `准考证号` | 与其他查询号码至少填写一项 |
| `考生号` | 与其他查询号码至少填写一项 |
| `报名序号` | 与其他查询号码至少填写一项 |

导入器会忽略无关列，并扫描 Excel 前 20 行定位表头，因此允许在正式表头上方保留学校标题行。

真实学生文件建议保存为：

```text
data/students.xlsx
```

`data/` 默认被 Git 忽略，仅虚构模板允许提交。

## 查询配置

需要自定义查询地址或页面选择器时：

```powershell
Copy-Item config.example.json config.local.json
```

常用配置：

| 配置项 | 说明 |
| --- | --- |
| `queryUrl` | 官方成绩查询地址 |
| `queryMode` | `idCard` 或 `registrationNo` |
| `minDelayMs` / `maxDelayMs` | 学生之间的随机等待时间 |
| `resultTimeoutMs` | 提交后等待成绩页面的最长时间 |
| `captchaPollMs` | 检测人工验证完成状态的间隔 |
| `selectors` | 页面输入框、按钮和结果区域选择器 |
| `scoreMap` | 各科成绩对应的页面选择器 |

`config.local.json` 包含本机配置并已被 Git 忽略。正式入口页面变化后，可能需要重新校准选择器。

## 输出文件

GUI 每次运行会创建独立目录。开发模式默认写入 `output/gui-runs/`；安装版默认写入用户“文档/高考成绩查询助手/运行结果”。

每次运行通常包含：

```text
students.csv
import_report.json
events.jsonl
results.jsonl
failed_students.csv
score_summary.xlsx
screenshots/
run.log
```

这些文件可能包含个人信息，均不应提交或公开分享。

## 测试

授权服务测试需要先安装其独立依赖：

```powershell
npm --prefix license-server install
npm test
npm run app:build
```

测试范围包括：

- 暂停、继续、重试、跳过和停止控制
- 许可证签名、篡改检测、设备绑定和过期校验
- 在线激活、刷新、吊销和离线许可证
- 授权管理接口及 CSRF 防护

## Windows 构建

### 本地测试构建

```powershell
npm run dist:win
```

### 正式服务构建

正式发布前必须写入公网 HTTPS 授权服务地址：

```powershell
$env:GAOKAO_LICENSE_API_URL = "https://license.example.com"
npm run dist:win
```

构建产物位于 `dist-electron/`：

- `高考成绩查询助手 Setup 0.1.0.exe`：安装版
- `高考成绩查询助手 0.1.0.exe`：免安装版
- `win-unpacked/`：本地测试目录

安装包内置 Chromium，最终用户不需要另外安装 Node.js、Python 或浏览器。

当前项目未提供代码签名证书，Windows 可能显示“未知发布者”。生产发布建议配置代码签名并使用：

```powershell
npm run dist:win:signed
```

## 授权服务器

授权服务负责激活码、设备绑定、在线刷新和离线许可证签发，不接收学生表或成绩数据。

完整的本地联调、Docker、Caddy、VPS 部署和备份说明见：

[license-server/README.md](license-server/README.md)

以下内容绝不能提交：

- `.license-secrets/`
- `license-server/.env`
- `license-server/secrets/`
- `license-server/data/`
- 管理员密码及激活码 Pepper

## 项目结构

```text
app/                 Electron 主进程、授权模块和 React GUI
src/                 Playwright 查询核心
tools/               导入、汇总、测试和构建脚本
demo/                本地模拟页面与虚构数据
shared/              客户端与服务端共用的许可证协议
license-server/      授权服务、管理后台和 Docker 配置
test/                授权相关自动化测试
data/                本地学生表目录，仅提交虚构模板
output/              查询结果和截图，不提交
work/                运行中间文件，不提交
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run demo` | 运行本地完整 Demo |
| `npm run app:dev` | 启动 Electron 开发模式 |
| `npm test` | 运行控制流程和授权测试 |
| `npm run app:build` | 构建前端资源 |
| `npm run dist:win` | 构建 Windows 安装版和免安装版 |
| `npm run test:packaged` | 对已构建应用执行冒烟测试 |
| `npm run license:keygen -- local-dev` | 生成独立的本地开发签名密钥 |
| `npm run license:server` | 启动授权服务 |

## 已知限制

- 真实成绩入口开放或页面结构变化后，可能需要更新选择器
- 图片点选、滑块等人机验证必须由用户本人完成
- 当前主要支持 Windows
- 当前安装包未配置正式代码签名和自定义应用图标
- 本地软件授权只能提高滥用成本，不能替代服务端权限控制

## 参与贡献

提交 Issue 或 Pull Request 前，请确保：

1. 不包含真实学生数据、成绩、截图、许可证或服务器密钥
2. `npm test` 通过
3. `npm run app:build` 通过
4. 新功能同步更新文档或测试

## 许可证

本仓库当前未附加开源许可证。公开可见不代表允许复制、修改或分发；如需开放协作，请先添加明确的开源许可证。
