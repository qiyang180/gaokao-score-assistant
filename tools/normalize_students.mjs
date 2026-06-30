import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ExcelJS from 'exceljs';
import { readCsvRecords, writeCsvRecords } from './lib/csv.mjs';

const REQUIRED_NAME = '姓名';
const ID_COLUMNS = ['身份证号', '准考证号', '考生号', '报名序号'];
const OUTPUT_COLUMNS = ['班级', '姓名', '身份证号', '准考证号', '考生号', '报名序号'];
const FIELD_ALIASES = {
  班级: ['班级', '行政班', '班别'],
  姓名: ['姓名', '考生姓名', '学生姓名'],
  身份证号: ['身份证号', '身份证号码', '证件号', '证件号码', '居民身份证号'],
  准考证号: ['准考证号', '准考证号码'],
  考生号: ['考生号', '考生号码'],
  报名序号: ['报名序号', '报名号'],
};

function parseArgs(argv) {
  const args = {
    input: '',
    out: path.join('work', 'students.csv'),
    report: '',
    preview: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--input') {
      args.input = argv[index + 1] || '';
      index += 1;
    } else if (key === '--out') {
      args.out = argv[index + 1] || '';
      index += 1;
    } else if (key === '--report') {
      args.report = argv[index + 1] || '';
      index += 1;
    } else if (key === '--preview') {
      args.preview = true;
    }
  }
  if (!args.input) {
    throw new Error('--input is required');
  }
  if (!args.out) {
    throw new Error('--out is required');
  }
  return args;
}

function normalizeHeader(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function looksLikeHeader(headers) {
  const values = new Set(headers.filter(Boolean));
  if (!FIELD_ALIASES[REQUIRED_NAME].some((alias) => values.has(alias))) {
    return false;
  }
  return ID_COLUMNS.some((column) => FIELD_ALIASES[column].some((alias) => values.has(alias)));
}

function normalizeRecord(record) {
  const normalized = { __row: record.__row };
  for (const [outputColumn, aliases] of Object.entries(FIELD_ALIASES)) {
    normalized[outputColumn] = '';
    for (const alias of aliases) {
      if (record[alias]) {
        normalized[outputColumn] = String(record[alias]).trim();
        break;
      }
    }
  }
  return normalized;
}

function cellText(cell) {
  if (cell.value === null || cell.value === undefined) {
    return '';
  }
  return String(cell.text || cell.value).trim();
}

async function readXlsx(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return [];
  }

  let headerRowNumber = 1;
  let headers = [];
  const scanLimit = Math.min(20, worksheet.rowCount);
  for (let rowNumber = 1; rowNumber <= scanLimit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const candidate = [];
    for (let column = 1; column <= row.cellCount; column += 1) {
      candidate.push(normalizeHeader(cellText(row.getCell(column))));
    }
    if (looksLikeHeader(candidate)) {
      headerRowNumber = rowNumber;
      headers = candidate;
      break;
    }
    if (rowNumber === 1) {
      headers = candidate;
    }
  }

  const records = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const record = { __row: rowNumber };
    headers.forEach((header, index) => {
      if (header) {
        record[header] = cellText(row.getCell(index + 1));
      }
    });
    if (Object.entries(record).some(([key, value]) => key !== '__row' && value)) {
      records.push(record);
    }
  }
  return records;
}

function readCsv(filePath) {
  return readCsvRecords(filePath)
    .map((record, index) => ({
      ...Object.fromEntries(
        Object.entries(record).map(([key, value]) => [normalizeHeader(key), String(value || '').trim()]),
      ),
      __row: index + 2,
    }))
    .filter((record) => Object.entries(record).some(([key, value]) => key !== '__row' && value));
}

function validate(records) {
  const errors = [];
  const invalidRows = new Set();
  for (const record of records) {
    const reasons = [];
    if (!record[REQUIRED_NAME]) {
      reasons.push('缺少姓名');
    }
    if (!ID_COLUMNS.some((column) => record[column])) {
      reasons.push('缺少身份证号/准考证号/考生号/报名序号');
    }
    if (reasons.length) {
      invalidRows.add(record.__row);
      errors.push({ row: record.__row, reasons });
    }
  }
  return { errors, invalidRows };
}

function writeReport(reportPath, report) {
  if (!reportPath) {
    return;
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function normalizeStudentsFile(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`input file not found: ${inputPath}`);
  }
  const extension = path.extname(inputPath).toLowerCase();
  let sourceRecords;
  if (extension === '.xlsx') {
    sourceRecords = await readXlsx(inputPath);
  } else if (extension === '.csv') {
    sourceRecords = readCsv(inputPath);
  } else {
    throw new Error('只支持 .xlsx 或 .csv 学生表');
  }

  const records = sourceRecords.map(normalizeRecord);
  const { errors, invalidRows } = validate(records);
  const validRecords = records.filter((record) => !invalidRows.has(record.__row));
  return {
    records,
    validRecords,
    errors,
    stats: {
      total: records.length,
      valid: validRecords.length,
      invalid: invalidRows.size,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const normalized = await normalizeStudentsFile(args.input);
  writeReport(args.report, {
    stats: normalized.stats,
    errors: normalized.errors,
  });

  if (!normalized.records.length) {
    throw new Error('学生表为空');
  }
  if (normalized.errors.length && !args.preview) {
    throw new Error(
      normalized.errors
        .map((item) => `第 ${item.row} 行${item.reasons.join('；')}`)
        .join('\n'),
    );
  }

  writeCsvRecords(args.out, OUTPUT_COLUMNS, normalized.validRecords);
  console.log(
    `normalized ${normalized.stats.valid}/${normalized.stats.total} students -> ${args.out}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
