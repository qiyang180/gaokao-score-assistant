import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const statusText = {
  pending: '待查询',
  running: '查询中',
  ok: '成功',
  failed: '失败',
  skipped: '已跳过',
  no_scores: '无成绩',
};

function basename(filePath) {
  return (filePath || '').split(/[\\/]/).pop() || '';
}

function App() {
  const [defaults, setDefaults] = useState(null);
  const [studentsFile, setStudentsFile] = useState('');
  const [outputRoot, setOutputRoot] = useState('');
  const [queryUrl, setQueryUrl] = useState('');
  const [minDelaySeconds, setMinDelaySeconds] = useState('1');
  const [maxDelaySeconds, setMaxDelaySeconds] = useState('2');
  const [resultTimeoutSeconds, setResultTimeoutSeconds] = useState('10');
  const [preview, setPreview] = useState({ students: [], stats: null, errors: [] });
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [runState, setRunState] = useState('idle');
  const [current, setCurrent] = useState(null);
  const [logs, setLogs] = useState([]);
  const [paths, setPaths] = useState({});
  const [message, setMessage] = useState('');
  const [paused, setPaused] = useState(false);
  const logRef = useRef(null);

  const counts = useMemo(() => {
    const values = { ok: 0, failed: 0, skipped: 0, no_scores: 0, pending: 0, running: 0 };
    for (const student of preview.students) {
      values[student.status] = (values[student.status] || 0) + 1;
    }
    return values;
  }, [preview.students]);

  useEffect(() => {
    window.gaokao.getDefaults().then((data) => {
      setDefaults(data);
      setQueryUrl(data.queryUrl || '');
      setOutputRoot(data.outputRoot || '');
      setMinDelaySeconds(String(Number(data.minDelayMs ?? 1000) / 1000));
      setMaxDelaySeconds(String(Number(data.maxDelayMs ?? 2000) / 1000));
      setResultTimeoutSeconds(String(Number(data.resultTimeoutMs ?? 10000) / 1000));
      if (data.browserReady === false) {
        setMessage('安装包缺少 Playwright Chromium，请重新安装完整版本。');
      }
    });
    const unsubs = [
      window.gaokao.onRunStarted((data) => {
        setPaths(data);
        setRunState('running');
        setPaused(false);
        pushLog('system', `任务已启动：${data.runDir}`);
      }),
      window.gaokao.onRunEvent(handleRunEvent),
      window.gaokao.onLog(({ stream, text }) => pushLog(stream, text)),
      window.gaokao.onRunClosed((data) => {
        setPaths((old) => ({ ...old, ...data }));
        setRunState(data.status === 'completed' ? 'completed' : data.status);
        setPaused(false);
        pushLog('system', data.error ? `任务结束：${data.error}` : `任务结束：${data.status}`);
      }),
    ];
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  function pushLog(stream, text) {
    setLogs((old) => [...old.slice(-400), { stream, text, id: `${Date.now()}-${Math.random()}` }]);
  }

  function setStudentStatus(index, status, extra = {}) {
    setPreview((old) => ({
      ...old,
      students: old.students.map((student) => (
        student.index === index ? { ...student, status, ...extra } : student
      )),
    }));
  }

  function handleRunEvent(event) {
    if (event.type === 'run:start') {
      setRunState('running');
      setCurrent(null);
      setPaths((old) => ({ ...old, ...event }));
    } else if (event.type === 'run:paused') {
      setPaused(true);
    } else if (event.type === 'run:resumed') {
      setPaused(false);
    } else if (event.type === 'student:start') {
      setPaused(false);
      setCurrent({
        index: event.index,
        total: event.total,
        student: event.student,
        stage: '填写与验证',
        active: true,
      });
      setStudentStatus(event.index, 'running');
    } else if (event.type === 'student:retrying') {
      setPaused(false);
      setCurrent((old) => old ? {
        ...old,
        stage: `正在重试（第 ${event.attempt} 次）`,
        active: true,
      } : old);
      setStudentStatus(event.index, 'running', { error: '', scores: {} });
    } else if (event.type === 'captcha:waiting') {
      setCurrent((old) => old ? { ...old, stage: '等待人工验证码' } : old);
    } else if (event.type === 'captcha:verified') {
      setCurrent((old) => old ? { ...old, stage: '验证码已通过，正在提交' } : old);
    } else if (event.type === 'result:waiting') {
      setCurrent((old) => old ? { ...old, stage: '等待成绩页面返回' } : old);
    } else if (event.type === 'result:ready') {
      setCurrent((old) => old ? {
        ...old,
        stage: event.detected ? '成绩页面已返回，正在解析' : '等待超时，正在尝试解析',
      } : old);
    } else if (event.type === 'student:ok' || event.type === 'student:failed') {
      setPaused(false);
      const result = event.result || {};
      setStudentStatus(event.index, result.status || (event.type === 'student:ok' ? 'ok' : 'failed'), {
        scores: result.scores || {},
        error: result.error || '',
        screenshotPath: result.screenshotPath || '',
      });
      const outcomeText = {
        ok: '完成',
        failed: '失败',
        skipped: '已跳过',
        no_scores: '未提取到成绩',
      };
      setCurrent((old) => old ? {
        ...old,
        stage: outcomeText[result.status] || '完成',
        active: false,
      } : old);
    } else if (event.type === 'summary:done') {
      setPaths((old) => ({ ...old, summaryPath: event.path }));
      setRunState('completed');
    } else if (event.type === 'run:stopped') {
      setRunState('stopped');
    }
  }

  async function selectStudents() {
    const file = await window.gaokao.selectStudents();
    if (!file) {
      return;
    }
    setStudentsFile(file);
    await previewStudents(file);
  }

  async function previewStudents(file = studentsFile) {
    if (!file) {
      return;
    }
    setLoadingPreview(true);
    setMessage('');
    try {
      const data = await window.gaokao.previewStudents({ studentsFile: file });
      setPreview(data);
    } catch (error) {
      setPreview({ students: [], stats: null, errors: [] });
      setMessage(error.message);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function selectOutputDir() {
    const dir = await window.gaokao.selectOutputDir();
    if (dir) {
      setOutputRoot(dir);
    }
  }

  async function startRun() {
    setLogs([]);
    setMessage('');
    setCurrent(null);
    setRunState('starting');
    setPreview((old) => ({
      ...old,
      students: old.students.map((student) => ({ ...student, status: 'pending', error: '', scores: {} })),
    }));
    try {
      await window.gaokao.startRun({
        studentsFile,
        outputRoot,
        queryUrl,
        configPath: defaults?.configPath,
        minDelayMs: Number(minDelaySeconds) * 1000,
        maxDelayMs: Number(maxDelaySeconds) * 1000,
        resultTimeoutMs: Number(resultTimeoutSeconds) * 1000,
      });
    } catch (error) {
      setRunState('idle');
      setMessage(error.message);
    }
  }

  async function sendControl(command) {
    setMessage('');
    try {
      const response = await window.gaokao.control({ command });
      if (!response.ok) {
        setMessage(response.message);
        return;
      }
      if (command === 'pause') {
        setPaused(true);
      } else if (command === 'resume') {
        setPaused(false);
      } else if (command === 'retry') {
        setCurrent((old) => old ? { ...old, stage: '正在请求重试' } : old);
      } else if (command === 'stop') {
        setRunState('stopping');
      }
    } catch (error) {
      setMessage(error.message);
    }
  }

  const timingValid = Number.isFinite(Number(minDelaySeconds))
    && Number.isFinite(Number(maxDelaySeconds))
    && Number.isFinite(Number(resultTimeoutSeconds))
    && Number(minDelaySeconds) >= 0
    && Number(maxDelaySeconds) >= Number(minDelaySeconds)
    && Number(resultTimeoutSeconds) >= 1;
  const canStart = studentsFile
    && preview.students.length > 0
    && preview.stats?.invalid === 0
    && timingValid
    && runState !== 'running'
    && runState !== 'starting'
    && runState !== 'stopping';
  const isActive = runState === 'running' || runState === 'starting';
  const hasActiveStudent = isActive && Boolean(current?.active);
  const progressTotal = preview.students.length || current?.total || 0;
  const finished = counts.ok + counts.failed + counts.skipped + counts.no_scores;
  const progress = progressTotal ? Math.round((finished / progressTotal) * 100) : 0;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>高考成绩查询助手</h1>
          <p>选择学生表，人工完成验证码，程序自动查询、截图并生成汇总。</p>
        </div>
        <div className={`state-pill state-${runState}`}>{runState}</div>
      </header>

      {message && <div className="alert">{message}</div>}

      <section className="workspace">
        <aside className="side">
          <section className="panel">
            <h2>输入</h2>
            <button className="primary" onClick={selectStudents}>选择 Excel/CSV</button>
            <div className="path-text" title={studentsFile}>{studentsFile ? basename(studentsFile) : '未选择学生表'}</div>
            {preview.stats && (
              <div className={`validation-summary ${preview.stats.invalid ? 'has-errors' : ''}`}>
                有效 {preview.stats.valid} 行 / 无效 {preview.stats.invalid} 行
              </div>
            )}
            {preview.errors?.length > 0 && (
              <div className="validation-errors">
                {preview.errors.map((item) => (
                  <p key={item.row}>第 {item.row} 行：{item.reasons.join('；')}</p>
                ))}
              </div>
            )}
            <button onClick={() => previewStudents()} disabled={!studentsFile || loadingPreview}>
              {loadingPreview ? '校验中...' : '重新校验'}
            </button>
          </section>

          <section className="panel">
            <h2>配置</h2>
            <label>
              查询网址
              <input value={queryUrl} onChange={(event) => setQueryUrl(event.target.value)} />
            </label>
            <label>
              输出目录
              <div className="inline">
                <input value={outputRoot} onChange={(event) => setOutputRoot(event.target.value)} />
                <button onClick={selectOutputDir}>选择</button>
              </div>
            </label>
            <div className="timing-grid">
              <label>
                最短间隔（秒）
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={minDelaySeconds}
                  onChange={(event) => setMinDelaySeconds(event.target.value)}
                />
              </label>
              <label>
                最长间隔（秒）
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={maxDelaySeconds}
                  onChange={(event) => setMaxDelaySeconds(event.target.value)}
                />
              </label>
              <label className="wide">
                结果等待上限（秒）
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={resultTimeoutSeconds}
                  onChange={(event) => setResultTimeoutSeconds(event.target.value)}
                />
              </label>
            </div>
            {!timingValid && <div className="field-error">请检查查询间隔和结果等待时间</div>}
            <button className="primary" onClick={startRun} disabled={!canStart}>开始查询</button>
          </section>

          <section className="panel">
            <h2>控制</h2>
            <div className="control-grid">
              <button onClick={() => sendControl(paused ? 'resume' : 'pause')} disabled={!isActive}>
                {paused ? '继续' : '暂停'}
              </button>
              <button onClick={() => sendControl('skip')} disabled={!hasActiveStudent}>跳过当前</button>
              <button onClick={() => sendControl('retry')} disabled={!hasActiveStudent}>重试当前</button>
              <button className="danger" onClick={() => sendControl('stop')} disabled={!isActive}>停止</button>
            </div>
          </section>

          <section className="panel">
            <h2>输出</h2>
            <OutputButton label="汇总表" path={paths.summaryPath} />
            <OutputButton label="截图目录" path={paths.screenshotsDir} />
            <OutputButton label="运行目录" path={paths.runDir || paths.outputDir} />
            <OutputButton label="运行日志" path={paths.logPath} />
          </section>
        </aside>

        <section className="content">
          <section className="overview">
            <div className="metric">
              <span>总人数</span>
              <strong>{preview.stats?.total || 0}</strong>
            </div>
            <div className="metric ok">
              <span>成功</span>
              <strong>{counts.ok}</strong>
            </div>
            <div className="metric warn">
              <span>失败/无成绩</span>
              <strong>{counts.failed + counts.no_scores}</strong>
            </div>
            <div className="metric">
              <span>进度</span>
              <strong>{progress}%</strong>
            </div>
          </section>

          <section className="current">
            <div>
              <h2>{current?.student?.name || '等待开始'}</h2>
              <p>{current ? `第 ${current.index} / ${current.total} 人 · ${current.stage}` : '导入学生表后即可开始查询'}</p>
            </div>
            <div className="progress-bar"><span style={{ width: `${progress}%` }} /></div>
          </section>

          <section className="table-panel">
            <div className="section-head">
              <h2>学生与结果</h2>
              <span>{preview.students.length} 条</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>班级</th>
                    <th>姓名</th>
                    <th>身份证</th>
                    <th>考生号</th>
                    <th>报名序号</th>
                    <th>状态</th>
                    <th>总分</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.students.map((student) => (
                    <tr key={student.index} className={`row-${student.status}`}>
                      <td>{student.index}</td>
                      <td>{student.className}</td>
                      <td>{student.name}</td>
                      <td>{student.idCardMasked}</td>
                      <td>{student.examineeNoMasked || student.admissionNoMasked}</td>
                      <td>{student.registrationNoMasked}</td>
                      <td>{statusText[student.status] || student.status}</td>
                      <td>{student.scores?.['总分'] || ''}</td>
                      <td title={student.error}>{student.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="log-panel">
            <div className="section-head">
              <h2>运行日志</h2>
              <span>{logs.length} 行</span>
            </div>
            <div className="logs" ref={logRef}>
              {logs.map((item) => (
                <div key={item.id} className={`log log-${item.stream}`}>
                  <span>{item.stream}</span>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

function OutputButton({ label, path }) {
  return (
    <button onClick={() => window.gaokao.openPath(path)} disabled={!path} title={path || ''}>
      {label}
    </button>
  );
}

createRoot(document.getElementById('root')).render(<App />);
