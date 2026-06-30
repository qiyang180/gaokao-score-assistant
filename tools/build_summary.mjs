import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { readCsvRecords } from './lib/csv.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyTemplate = path.resolve(projectRoot, '..', '2026高考成绩汇总--理科.xlsx');
const DEFAULT_SUBJECTS = [
  '总分',
  '语文',
  '数学',
  '外语',
  '物理',
  '历史',
  '化学',
  '生物',
  '思想政治',
  '地理',
];
const EXTRA_HEADERS = ['查询状态', '截图路径', '错误原因', '查询时间'];
const GENERIC_STUDENT_HEADERS = ['班级', '姓名', '身份证号', '准考证号', '考生号', '报名序号'];
const STUDENT_HEADER_ALIASES = {
  班级: ['班级'],
  姓名: ['姓名', '学生姓名', '考生姓名'],
  学生姓名: ['姓名', '学生姓名', '考生姓名'],
  考生姓名: ['姓名', '学生姓名', '考生姓名'],
  身份证号: ['身份证号', '身份证号码', '证件号', '证件号码'],
  身份证号码: ['身份证号', '身份证号码', '证件号', '证件号码'],
  准考证号: ['准考证号'],
  考生号: ['考生号', '准考证号'],
  报名序号: ['报名序号', '报名号'],
};
const SCORE_HEADER_ALIASES = {
  英语: ['英语', '外语'],
  生物: ['生物', '生物学'],
  '生物/政治/地理': ['生物/政治/地理', '生物', '生物学', '思想政治', '政治', '地理'],
};

function parseArgs(argv) {
  const args = {
    results: path.join('output', 'results.jsonl'),
    students: path.join('work', 'students.csv'),
    template: '',
    out: path.join('output', '成绩汇总.xlsx'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--results') {
      args.results = argv[index + 1] || '';
      index += 1;
    } else if (key === '--students') {
      args.students = argv[index + 1] || '';
      index += 1;
    } else if (key === '--template') {
      args.template = argv[index + 1] || '';
      index += 1;
    } else if (key === '--out') {
      args.out = argv[index + 1] || '';
      index += 1;
    }
  }
  return args;
}

function loadResults(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`results file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSON at line ${index + 1}: ${error.message}`);
      }
    });
}

function getFirst(mapping, aliases) {
  for (const key of aliases) {
    const value = mapping?.[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function resultStudentName(item) {
  return String(item.student?.name || '').trim();
}

function matchStudents(results, students) {
  const byName = new Map();
  for (const student of students) {
    const name = String(getFirst(student, STUDENT_HEADER_ALIASES.姓名)).trim();
    if (!name) {
      continue;
    }
    const candidates = byName.get(name) || [];
    candidates.push(student);
    byName.set(name, candidates);
  }
  return results.map((item) => {
    const candidates = byName.get(resultStudentName(item)) || [];
    return candidates.shift() || {};
  });
}

function collectSubjects(results) {
  const subjects = [...DEFAULT_SUBJECTS];
  const seen = new Set(subjects);
  for (const item of results) {
    for (const subject of Object.keys(item.scores || {})) {
      if (!seen.has(subject)) {
        seen.add(subject);
        subjects.push(subject);
      }
    }
  }
  return subjects;
}

function cloneStyle(style) {
  return style ? JSON.parse(JSON.stringify(style)) : {};
}

function columnLetter(number) {
  let value = number;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

async function loadWorkbook(templatePath, subjects) {
  const workbook = new ExcelJS.Workbook();
  if (templatePath && fs.existsSync(templatePath)) {
    await workbook.xlsx.readFile(templatePath);
    return workbook;
  }

  const worksheet = workbook.addWorksheet('成绩汇总');
  const headers = [...GENERIC_STUDENT_HEADERS, ...subjects, ...EXTRA_HEADERS];
  worksheet.addRow(headers);
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9EAF7' },
    };
  });
  return workbook;
}

function ensureHeaders(worksheet, requiredHeaders) {
  const headerMap = new Map();
  const headerRow = worksheet.getRow(1);
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    const value = String(headerRow.getCell(column).text || '').trim();
    if (value) {
      headerMap.set(value, column);
    }
  }

  const styleSource = headerRow.getCell(Math.max(1, worksheet.columnCount));
  for (const header of requiredHeaders) {
    if (headerMap.has(header)) {
      continue;
    }
    const column = worksheet.columnCount + 1;
    const cell = headerRow.getCell(column);
    cell.value = header;
    cell.style = cloneStyle(styleSource.style);
    headerMap.set(header, column);
  }
  return headerMap;
}

function valueForHeader(header, item, student) {
  const scores = item.scores || {};
  if (STUDENT_HEADER_ALIASES[header]) {
    return getFirst(student, STUDENT_HEADER_ALIASES[header])
      || (['姓名', '学生姓名', '考生姓名'].includes(header) ? resultStudentName(item) : '');
  }
  if (header === '查询状态') {
    return item.status || '';
  }
  if (header === '截图路径') {
    return item.screenshotPath || '';
  }
  if (header === '错误原因') {
    return item.error || '';
  }
  if (header === '查询时间') {
    return item.queriedAt || '';
  }
  if (SCORE_HEADER_ALIASES[header]) {
    return getFirst(scores, SCORE_HEADER_ALIASES[header]);
  }
  return scores[header] ?? '';
}

function clearOutputArea(worksheet, headerMap, resultCount) {
  const maxRow = Math.max(worksheet.rowCount, resultCount + 1);
  for (let row = 2; row <= maxRow; row += 1) {
    for (const column of headerMap.values()) {
      worksheet.getRow(row).getCell(column).value = null;
    }
  }
}

function autosizeColumns(worksheet) {
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    let maxLength = 0;
    worksheet.getColumn(column).eachCell({ includeEmpty: true }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.text || '').length);
    });
    worksheet.getColumn(column).width = Math.min(Math.max(maxLength + 2, 10), 48);
  }
}

export async function buildSummary({
  resultsPath,
  studentsPath,
  outputPath,
  templatePath = '',
}) {
  const results = loadResults(resultsPath);
  const students = readCsvRecords(studentsPath);
  const subjects = collectSubjects(results);
  const workbook = await loadWorkbook(templatePath, subjects);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('汇总模板中没有工作表');
  }

  const existingHeaders = [];
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    const value = String(worksheet.getRow(1).getCell(column).text || '').trim();
    if (value) {
      existingHeaders.push(value);
    }
  }
  const baseHeaders = existingHeaders.length
    ? existingHeaders
    : [...GENERIC_STUDENT_HEADERS, ...subjects];
  const headerMap = ensureHeaders(worksheet, [...baseHeaders, ...EXTRA_HEADERS]);
  const dataStyle = new Map();
  for (const [header, column] of headerMap.entries()) {
    dataStyle.set(header, cloneStyle(worksheet.getRow(2).getCell(column).style));
  }
  clearOutputArea(worksheet, headerMap, results.length);

  const matchedStudents = matchStudents(results, students);
  results.forEach((item, index) => {
    const row = worksheet.getRow(index + 2);
    for (const [header, column] of headerMap.entries()) {
      const cell = row.getCell(column);
      cell.value = valueForHeader(header, item, matchedStudents[index]);
      cell.style = dataStyle.get(header) || {};
    }
  });

  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.autoFilter = `A1:${columnLetter(worksheet.columnCount)}${Math.max(1, results.length + 1)}`;
  autosizeColumns(worksheet);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const templatePath = args.template || (fs.existsSync(legacyTemplate) ? legacyTemplate : '');
  await buildSummary({
    resultsPath: args.results,
    studentsPath: args.students,
    outputPath: args.out,
    templatePath,
  });
  console.log(`summary written: ${args.out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
