# 河南高考成绩批量查询助手

这个项目用于在官方成绩查询入口开放后，批量完成：

- 自动填写学生姓名、身份证号/准考证号
- 人工输入验证码
- 自动提交查询
- 自动保存每位学生成绩截图
- 自动提取页面成绩并汇总为 Excel

验证码保留人工输入，不做验证码破解或绕过。

## 当前可提前完成的工作

1. 准备学生信息表
   - 参考 `data/students_template.csv`
   - 支持字段：`姓名`、`身份证号`、`准考证号`、`考生号`、`报名序号`
   - 也兼容常见学校表头，例如 `序号`、`班级`、`姓名`、`性别`、`考点`、`身份证号`、`考生号`、`报名序号`
   - 额外列会被自动忽略；`考生号`、`报名序号` 会被独立保留，便于真实页面需要哪个就填写哪个
   - 每行至少要有姓名，以及身份证号、准考证号、考生号、报名序号之一

2. 准备本地配置
   - 项目已经提供 `config.local.json`
   - 默认地址是 `https://pzwb.haeea.cn/stu`
   - 脚本会自动尝试定位姓名、身份证号、准考证号、验证码、查询按钮
   - 只有自动定位失败时，才需要手动补页面选择器

3. 安装浏览器自动化依赖

```powershell
npm install
npm run install:browsers
```

4. 提前跑通本地 demo

在真实入口开放前，可以先跑本地模拟查询页，验证学生表标准化、自动填写、提交、截图、成绩解析和 Excel 汇总。模拟页已经尽量贴近真实官网的字段、结果表格和图片点选验证结构：

```powershell
npm run demo
```

demo 输出位置：

- 截图：`output/demo/screenshots/`
- 原始查询结果：`output/demo/results.jsonl`
- 汇总表：`output/demo/summary.xlsx`

demo 默认跳过验证码输入提示，便于一次性跑完。如果要手动体验验证码输入，把 `demo/config.demo.json` 里的 `skipCaptchaPrompt` 改成 `false`。

如果只想手动体验官网式图片验证，可以直接用浏览器打开 `demo/mock_query.html`：点击“点击进行验证”，按提示依次点选“记、辨、饱”，然后点“确定”。`npm run demo` 会自动追加 `?autoCaptcha=1`，用于回归测试时跳过本地模拟验证。

5. 一键运行真实查询

默认读取 `data/students.xlsx`：

```powershell
npm run night
```

如果学生表路径不同：

```powershell
powershell -ExecutionPolicy Bypass -File tools/run_query.ps1 -Students "你的学生表.xlsx"
```

如果今晚放出的真实查询链接不是默认地址：

```powershell
powershell -ExecutionPolicy Bypass -File tools/run_query.ps1 -Students "data/students.xlsx" -Url "真实查询链接"
```

## 查询时你需要做什么

脚本会逐个学生打开查询页、填写信息，然后在终端提示：

```powershell
请在浏览器中为 张三 完成图片验证，脚本检测到验证成功后会自动继续。
```

真实页面使用的是图片点选/滑块类人机验证，不是文本验证码。操作方式是：

- 在浏览器里点击“点击进行验证”
- 按弹窗要求依次点选图片中的文字或完成滑块
- 点击验证弹窗里的“确定”
- 页面显示“验证成功”后，脚本会在约 0.2 秒轮询间隔内识别，并自动点击“查询”

提交后脚本会自动截图、解析成绩，并继续下一个学生。

输出位置：

- 截图：`output/screenshots/学生姓名.png`
- 原始查询结果：`output/results.jsonl`
- 汇总表：`output/score_summary.xlsx`

汇总表会默认以项目上级目录的 `2026高考成绩汇总--理科.xlsx` 为模板生成，并用 `work/students.csv` 补齐班级、身份证号码、考生号、报名序号等基础信息。

## 正式开放后需要补的内容

因为当前成绩查询入口未开放，页面字段和成绩表格结构还不能确定。脚本会先自动识别控件；只有自动识别失败时，才需要补 `config.local.json`：

- `queryUrl`：真实成绩查询地址
- `queryMode`：查询方式，`idCard` 表示“考生号 + 身份证号”，`registrationNo` 表示“考生号 + 报名序号”
- `selectors.name`：姓名输入框选择器
- `selectors.idCard`：身份证号输入框选择器，如果页面需要
- `selectors.admissionNo`：准考证号输入框选择器，如果页面需要
- `selectors.examineeNo`：考生号输入框选择器，如果页面需要
- `selectors.registrationNo`：报名序号输入框选择器，如果页面需要
- `selectors.queryModeIdCard`：身份证号查询方式的单选按钮选择器
- `selectors.queryModeRegistrationNo`：报名序号查询方式的单选按钮选择器
- `selectors.captcha`：验证码输入框选择器
- `selectors.submit`：查询按钮选择器
- `selectors.resultContainer`：成绩结果区域选择器
- `captchaPollMs`：检测“验证成功”的轮询间隔，默认建议 `200`
- `captchaAutoConfirm`：是否让脚本尝试点击验证码弹窗里的“确定”，默认建议 `false`，即人工点击确认
- `scoreMap`：各科成绩对应的选择器，能配置就最稳；不配置时脚本会尝试自动解析表格和“科目：分数”文本

## 数据安全要求

- 不要把真实学生信息提交到第三方平台
- 不要使用在线验证码识别服务
- 查询结束后妥善处理 `data/`、`output/`、`work/` 中的敏感文件
- 分享结果时只分享必要成绩，不传播身份证号/准考证号
