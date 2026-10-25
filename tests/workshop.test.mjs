import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, copyFile, symlink, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), CLI = join(ROOT, 'bin/novel.mjs')
let sequence = 0
function command(script, args, expected = 0) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return expected ? result.stderr : JSON.parse(result.stdout)
}
const cli = (root, action, flags = [], expected = 0) => command(CLI, [action, root, ...flags], expected)
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tiancai-iteration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function payload(root, action, data, flags = [], expected = 0) {
  const dir = join(root, '.novel-workshop/drafts')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `input-${++sequence}.json`)
  await writeFile(path, JSON.stringify(data, null, 2))
  return cli(root, action, [...flags, '--source', path], expected)
}
const registry = async root => JSON.parse(await readFile(join(root, '.novel-workshop/project.json'), 'utf8'))
async function newBook(root, { start = 0, end = 2, mode = '原创', baseline, encoding = 'utf-8' } = {}) {
  cli(root, 'init', ['--start', String(start), '--end', String(end), '--chapters', String(end - start + 1), '--words', '100', '--interval', '2', '--title', '夜航 & 星河', '--mode', mode, '--length', mode === '原创' ? 'fixed' : 'source', ...(baseline ? ['--baseline', baseline, '--encoding', encoding] : [])])
  cli(root, 'gate', ['--through', '3', '--evidence', '03-大纲.md', '--source', '作者已批准，资料已核对'])
  cli(root, 'scope', ['--mode', 'continue', '--from', String(start), '--to', String(end), '--source', '作者授权本范围持续制作与普通返修', '--revise-approved'])
  if (mode === '改编精修') await payload(root, 'record', { id: 'R1', text: '按底本改编，保留事件成果', source: '作者本轮要求' }, ['--kind', 'requirement'])
}
async function manuscript(root, chapter, label = 'TOKEN') {
  await mkdir(join(root, '06-细纲'), { recursive: true })
  if (!existsSync(join(root, '06-细纲', `第${String(chapter).padStart(3, '0')}章.md`))) await writeFile(join(root, '06-细纲', `第${String(chapter).padStart(3, '0')}章.md`), `# 第${chapter}章\n目标：过河`)
  const path = join(root, '.novel-workshop/drafts', `${chapter}.md`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `# 第${String(chapter).padStart(3, '0')}章 过河\n\n${'春'.repeat(94)}\n\n唯一正文${label}_${chapter} & <星河> 😀 𠀀\n`)
  return path
}
async function finish(root, chapter) {
  const job = startJob(root, '文笔', 'finish', ['--chapter', String(chapter)])
  return collectResult(root, job, { notes: '记录实际持物、伤势与下一章承接。', experience: '用具体动作呈现场景，不重复规则说明。', exitState: { location: '河岸', next: '继续行程' } })
}
function startJob(root, role, action, flags = []) {
  const job = cli(root, 'dispatch', ['--role', role, '--action', action, ...flags])
  cli(root, 'task', ['--id', job.id, '--status', 'running', '--agent', `fixture-${role}-${++sequence}`])
  return job
}
async function collectResult(root, job, data, expected = 0) {
  await writeFile(job.resultPath, JSON.stringify(data))
  const result = cli(root, 'collect', ['--id', job.id], expected)
  if (expected) cli(root, 'task', ['--id', job.id, '--status', 'cancelled', '--reason', '验证失败结果未入库，结束本测试任务'])
  return result
}
async function writeChapter(root, chapter, source, exitState = { location: '河岸', next: '继续行程' }) {
  const job = startJob(root, '文笔', 'write', ['--chapter', String(chapter)])
  return collectResult(root, job, { text: await readFile(source, 'utf8'), notes: '记录实际持物、伤势与下一章承接。',
    experience: '用具体动作呈现场景，不重复规则说明。', exitState })
}
async function review(root, data, expected = 0) {
  const job = startJob(root, '复核', data.kind === 'final' ? 'final-review' : 'review', ['--chapters', data.chapters.map(x => x.chapter).join(',')])
  return collectResult(root, job, data, expected)
}
async function pass(root, chapters, final = false) {
  const draft = cli(root, 'accept', final ? ['--final'] : ['--chapters', chapters.join(',')])
  const data = draft.data
  data.verdict = 'passed'; data.summary = '集中读回本范围，并核对实际引文及前后承接。'
  for (const value of Object.values(data.grades)) { value.grade = 'B'; value.reason = '已结合本章原句和当前约束进行判断。' }
  for (const row of data.chapters) {
    row.outlineComplete = row.requirementsMet = row.logicChecked = row.styleChecked = true
    row.lengthReason = '场景与信息完整，篇幅仅作参照，没有填充重复段落。'
    const text = await readFile(resolve(root, row.path), 'utf8')
    row.evidence = [{ path: row.path, quote: text.split('\n').find(line => line.startsWith('唯一正文')) }]
  }
  await writeFile(draft.path, JSON.stringify(data))
  return review(root, data)
}
async function produce(root, maximum = 45) {
  for (let step = 0; step < maximum; step++) {
    const action = cli(root, 'doctor', ['--json']).nextAction
    if (action.type === 'complete') return
    if (action.type === 'outline') { await manuscript(root, action.chapters[0]); continue }
    if (action.type === 'write') {
      const n = action.chapters[0], source = await manuscript(root, n)
      await writeChapter(root, n, source); continue
    }
    if (action.type === 'finish') { for (const n of action.chapters) await finish(root, n); continue }
    if (action.type === 'review') { await pass(root, action.chapters); continue }
    if (action.type === 'calibrate') {
      const outline = Array.from({ length: action.to - action.from + 1 }, (_, i) => action.from + i)
      for (const id of outline) await manuscript(root, id)
      const job = startJob(root, '剧情', 'calibrate', ['--from', String(action.from), '--to', String(action.to)])
      await collectResult(root, job, { outline, note: '核对后续细纲、伏笔与事实，按本批结果微调。', source: '批次复盘' })
      continue
    }
    throw new Error(`意外调度动作：${JSON.stringify(action)}`)
  }
  throw new Error('诊断循环未在限定步数内完成')
}
function unzip(buffer) {
  const entries = new Map()
  let offset = 0
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18)
    const nameSize = buffer.readUInt16LE(offset + 26), extraSize = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString('utf8')
    const start = offset + 30 + nameSize + extraSize, bytes = buffer.subarray(start, start + size)
    entries.set(name, method === 0 ? bytes : inflateRawSync(bytes)); offset = start + size
  }
  return entries
}

test('安装可重入；自动发现并接手0号TXT/MD旧稿，保留原文件且按底本计量', async t => {
  const dir = await fixture(t), installed = join(dir, '安装 project')
  await mkdir(installed)
  const original = '# 作者原规则\n保留 $& 与中文。\n'
  await writeFile(join(installed, 'AGENTS.override.md'), original)
  const runInstall = () => spawnSync(process.execPath, [join(ROOT, 'bin/install.mjs'), '--target', 'codex', '--dir', installed], { encoding: 'utf8' })
  assert.equal(runInstall().status, 0)
  const first = await readFile(join(installed, 'AGENTS.override.md'), 'utf8')
  assert.equal(runInstall().status, 0)
  assert.equal(await readFile(join(installed, 'AGENTS.override.md'), 'utf8'), first)
  assert.ok(first.startsWith(original))
  const skillDir = join(installed, '.agents/skills/tiancai-novel'), skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) assert.ok(existsSync(resolve(skillDir, match[1])))
  const installedCLI = join(installed, '.novel-workshop/bin/novel.mjs')
  command(installedCLI, ['init', installed, '--start', '0', '--chapters', '3', '--words', '2500', '--interval', '10'])
  assert.deepEqual(command(installedCLI, ['doctor', installed, '--json']).nextAction.missing, ['mode'])
  command(installedCLI, ['config', installed, '--mode', '原创', '--source', '作者已明确原创'])
  assert.equal(command(installedCLI, ['doctor', installed, '--json']).nextAction.type, 'paused')
  assert.equal((await registry(installed)).end, 2)
  const unconfigured = join(dir, '首次参数未规定')
  cli(unconfigured, 'init')
  assert.deepEqual(cli(unconfigured, 'doctor').nextAction.missing, ['mode', 'plan', 'length', 'interval'])
  cli(unconfigured, 'config', ['--mode', '原创', '--start', '0', '--end', '2', '--length', 'fixed', '--words', '100', '--interval', '2', '--source', '用户明确这些参数'])
  assert.equal(cli(unconfigured, 'doctor').nextAction.type, 'paused')
  assert.equal(cli(unconfigured, 'doctor').nextAction.type, 'paused')

  const legacy = join(dir, '既有小说'), body = join(legacy, '正文改编/章节')
  await mkdir(body, { recursive: true })
  const zero = '\uFEFF引子 开场\n\n一段已经存在的原稿。\n'
  await writeFile(join(body, '000.txt'), zero)
  await writeFile(join(body, '001.md'), '# 第1章 旧稿\n\n长短章分别按原章判断。')
  await writeFile(join(legacy, '底本.txt'), `引子 开场\n${'源'.repeat(40)}\n第一章 过河\n${'源'.repeat(180)}\n第二章 到岸\n${'源'.repeat(70)}`)
  await writeFile(join(legacy, '正文改编/进度.json'), JSON.stringify({ 总位置数: 3, 已处理位置数: 1, 底本: '底本.txt', 下一个章号: 2 }))
  const discovery = cli(legacy, 'doctor', ['--json'])
  assert.equal(discovery.nextAction.type, 'import')
  assert.equal(discovery.discovery.candidates[0].first, 0)
  assert.equal(discovery.discovery.differences[0].code, 'legacy-progress-mismatch')
  assert.equal(existsSync(join(legacy, '.novel-workshop/project.json')), false)
  cli(legacy, 'import', ['--interval', '10'])
  cli(legacy, 'config', ['--mode', '改编精修', '--length', 'source', '--source', '现行文档明确改编并按对应底本篇幅'])
  const state = await registry(legacy)
  assert.deepEqual(Object.keys(state.chapters), ['0', '1'])
  assert.equal(state.reviews.length, 0)
  assert.equal(await readFile(join(body, '000.txt'), 'utf8'), zero)
  assert.equal(cli(legacy, 'prepare', ['--chapter', '1']).length.target, 180)
  assert.equal(cli(legacy, 'prepare', ['--chapter', '2']).length.target, 70)
  await payload(legacy, 'map', { chapter: 1, sourceIds: [1], treatment: '联动', baselineTreatment: '保留' })
  await payload(legacy, 'map', { chapter: 1, sourceIds: [1], treatment: '校正', baselineTreatment: '改写' })
  assert.equal((await registry(legacy)).chapters['1'].baselineTreatment, '保留')
  await writeFile(join(legacy, '参考.md'), '# 原作资料')
  await payload(legacy, 'record', { id: 'M1', path: '参考.md', kind: 'analysis' }, ['--kind', 'material'])
  await rm(join(legacy, '参考.md'))
  assert.ok(cli(legacy, 'doctor').diagnostics.some(x => x.type === 'repair-reference'))
  await payload(legacy, 'record', { id: 'M1', path: '参考.md', kind: 'analysis', status: 'retired' }, ['--kind', 'material'])
  cli(legacy, 'import', [], 1)
  cli(legacy, 'init', [], 1)
})

test('doctor驱动单会话完整循环，自动两更与尾批复审，最新终点和暂停约束生效', async t => {
  const root = await fixture(t)
  await newBook(root, { end: 4 })
  cli(root, 'scope', ['--mode', 'continue', '--from', '0', '--to', '3', '--source', '用户中途将终点改为3'])
  cli(root, 'scope', ['--mode', 'continue', '--from', '0', '--to', '2', '--source', '最新终点2'])
  await produce(root)
  let state = await registry(root)
  assert.deepEqual(Object.keys(state.chapters), ['0', '1', '2'])
  assert.equal(state.reviews.length, 2)
  assert.deepEqual(state.reviews[1].chapters.map(x => x.chapter), [2])
  assert.equal(cli(root, 'doctor').nextAction.type, 'complete')
  const before = await readFile(join(root, '07-注意事项.md'), 'utf8')
  await finish(root, 2)
  assert.equal(await readFile(join(root, '07-注意事项.md'), 'utf8'), before)
  assert.equal(state.experiences.length, 3)
  cli(root, 'scope', ['--mode', 'pause', '--source', '用户要求暂停'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'paused')
  const source = await manuscript(root, 3)
  cli(root, 'write', ['--chapter', '3', '--source', source], 1)
  cli(root, 'scope', ['--mode', 'review', '--from', '0', '--to', '2', '--source', '只审不改'])
  cli(root, 'write', ['--chapter', '0', '--source', source], 1)
  cli(root, 'scope', ['--mode', 'continue', '--from', '0', '--to', '4', '--source', '用户恢复至4'])
  await produce(root)
  cli(root, 'scope', ['--mode', 'continue', '--from', '0', '--to', '2', '--source', '只交付至2，其余保留'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'complete')
  state = await registry(root)
  assert.equal(Object.keys(state.chapters).length, 5)
  assert.ok(existsSync(join(root, state.chapters['4'].versions[0].path)))
  assert.ok(state.scopeHistory.length >= 6)
  assert.ok(state.checkpoint.scopeRevision === state.scope.revision)
})

test('要求/事实变更只使相关审阅失效；问题修复与撤销闭环，DSH共用版本入口', async t => {
  const root = await fixture(t)
  await newBook(root, { start: 1, end: 2 })
  await writeFile(join(root, '事实.txt'), '药盒归甲。\n药盒归乙。')
  await payload(root, 'record', { id: 'F1', text: '药盒归甲', entities: ['甲'], from: 1, to: 1, evidence: { path: '事实.txt', quote: '药盒归甲。' } }, ['--kind', 'fact'])
  await payload(root, 'map', { chapter: 1, treatment: '新增', entities: ['甲'], factIds: ['F1'] })
  await payload(root, 'map', { chapter: 2, treatment: '新增', entities: ['乙'] })
  assert.equal(cli(root, 'prepare', ['--chapter', '1']).facts.length, 1)
  assert.equal(cli(root, 'prepare', ['--chapter', '2']).facts.length, 0)
  await produce(root)
  await payload(root, 'record', { id: 'F1', text: '药盒归乙', from: 1, to: 1, evidence: { path: '事实.txt', quote: '药盒归乙。' } }, ['--kind', 'fact'])
  await payload(root, 'record', { id: 'R1', key: 'ownership', text: '以乙持有为准', from: 1, to: 1, source: '作者新要求' }, ['--kind', 'requirement'])
  const diagnosis = cli(root, 'doctor')
  assert.equal(diagnosis.latestApproved, 1)
  assert.ok(diagnosis.invalidReviews.every(x => x.chapter === 1))
  const draft = cli(root, 'accept', ['--chapters', '1'])
  draft.data.verdict = 'passed'; draft.data.summary = '拒绝没有引文的伪通过'
  await writeFile(draft.path, JSON.stringify(draft.data))
  await review(root, draft.data, 1)
  let state = await registry(root), original = state.chapters['1'].versions[0]
  const originalText = await readFile(join(root, original.path), 'utf8')
  const quote = originalText.split('\n').find(line => line.startsWith('唯一正文'))
  draft.data.verdict = 'rework'; draft.data.summary = '本段动作衔接需补修'
  draft.data.chapters[0].evidence = [{ path: original.path, quote }]
  const wrongRange = structuredClone(draft.data)
  wrongRange.issues = [{ text: '不能跨到未审的第2章', from: 1, to: 2, evidence: { path: original.path, quote } }]
  assert.match(await review(root, wrongRange, 1), /问题范围/)
  const wrongEvidence = structuredClone(draft.data), second = state.chapters['2'].versions.at(-1)
  wrongEvidence.issues = [{ text: '不能借其他章证据', from: 1, evidence: { path: second.path, quote: 'TOKEN_2' } }]
  assert.match(await review(root, wrongEvidence, 1), /问题证据/)
  draft.data.issues = [{ text: '本段动作衔接需补修', from: 1, evidence: { path: original.path, quote } }]
  await writeFile(draft.path, JSON.stringify(draft.data))
  await review(root, draft.data)
  assert.equal((await registry(root)).issues[0].to, 1)
  assert.equal(cli(root, 'doctor').nextAction.type, 'repair')
  cli(root, 'scope', ['--mode', 'revise', '--from', '1', '--to', '1', '--source', '作者授权修订已有稿', '--revise-approved'])
  const source = await manuscript(root, 1, 'REPAIRED')
  await writeChapter(root, 1, source)
  await finish(root, 1)
  state = await registry(root)
  const current = state.chapters['1'].versions.at(-1), currentText = await readFile(join(root, current.path), 'utf8')
  await payload(root, 'record', { id: 'I1', text: '本段动作衔接需补修', status: 'resolved', evidence: { path: current.path, quote: currentText.split('\n').find(line => line.startsWith('唯一正文')) } }, ['--kind', 'issue'], 1)
  await payload(root, 'record', { id: 'I1', text: '本段动作衔接需补修', status: 'resolved', resolution: '已保存新版本并读回动作', evidence: { path: current.path, quote: currentText.split('\n').find(line => line.startsWith('唯一正文')) } }, ['--kind', 'issue'])
  await pass(root, [1])
  assert.equal(await readFile(join(root, original.path), 'utf8'), originalText)
  await payload(root, 'record', { id: 'I2', text: '需要作者确认的取舍', from: 1, to: 1, requiresUser: true, evidence: { path: current.path, quote: 'REPAIRED_1' } }, ['--kind', 'issue'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'decision')
  await payload(root, 'record', { id: 'I2', text: '需要作者确认的取舍', status: 'retracted', resolution: '回查当前方案已明确，撤销误判' }, ['--kind', 'issue'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'complete')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'dsh-home')
  t.after(() => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome })
  const hooks = await import(pathToFileURL(join(ROOT, 'adapters/dsh/hooks.js')).href + '?iteration')
  const handlers = new Map(), injected = [], warnings = [], coordinatorGuards = []
  const ctx = { effect(fn) { return fn() }, on(name, fn) { handlers.set(name, fn); return () => {} }, systemPrompt: { section() { return () => {} } }, logger: { warn(x) { warnings.push(x) } },
    tools: { guard(fn) { coordinatorGuards.push(fn); return () => {} } }, workingDirectory: { async ensure(agent) { return agent.session.header.cwd } },
    fs: { async resolve(path, options) { return { path: resolve(options.cwd ?? root, path) } }, processPath(target) { return target.path } }, agents: { get(id) { return { inject(message) { injected.push({ id, message }) } } } } }
  hooks.apply(ctx)
  const guard = handlers.get('tools/pre-execute'), exec = { name: 'write', arguments: { file_path: current.path }, agent: { session: { header: { cwd: root } } } }
  assert.equal((await guard(exec, () => ({ kind: 'allow' }))).kind, 'deny')
  assert.equal((await guard({ ...exec, name: 'edit' }, () => ({ kind: 'allow' }))).kind, 'deny')
  const notify = handlers.get('session/event')
  notify({ id: 'a' }, { type: 'compaction/end', data: { error: '失败' } })
  notify({ id: 'a' }, { type: 'compaction/end', data: {} }); notify({ id: 'b' }, { type: 'compaction/end', data: {} })
  assert.deepEqual(injected.map(x => x.id), ['a', 'b'])
  assert.equal((await guard({ ...exec, name: 'workflow' }, () => ({ kind: 'allow' }))).kind, 'deny')
  const workerJob = startJob(root, '人物', 'plan'), workerState = await registry(root)
  const workerId = workerState.jobs.find(job => job.id === workerJob.id).agent
  const workerHandlers = new Map(), workerGuards = [], restrictions = [], presentations = []
  const workerCtx = { ...ctx, on(name, fn) { workerHandlers.set(name, fn); return () => {} },
    tools: { presentAs(mode) { presentations.push(mode) }, restrict(value) { restrictions.push(value) }, guard(fn) { workerGuards.push(fn); return () => {} } },
    workingDirectory: { async ensure() { return root } },
    agents: { get(id) { return id === 'captain' ? { session: { header: { id } } } : undefined } } }
  hooks.apply(workerCtx, { worker: true })
  assert.deepEqual(presentations, ['native']); assert.deepEqual(restrictions, [{ allow: [] }])
  const workerExec = { name: 'write', arguments: { file_path: join(workerJob.directory, 'safe.md') },
    agent: { session: { header: { id: workerId, cwd: tmpdir(), origin: 'subagent', parentSession: 'captain' } } } }
  const workerGuard = workerHandlers.get('tools/pre-execute')
  assert.equal((await workerGuard(workerExec, () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal(workerGuards[0](workerExec), undefined)
  assert.equal((await workerHandlers.get('fs/write-intent')({ path: workerExec.arguments.file_path }, workerExec, () => ({ kind: 'allow' }))).kind, 'allow')
  assert.match(workerGuards[0]({ ...workerExec }), /尚未通过/)
  for (const name of ['subagent', 'workflow', 'pwsh', 'run_code', 'send_message']) assert.equal((await workerGuard({ ...workerExec, name }, () => ({ kind: 'allow' }))).kind, 'deny')
  assert.equal((await workerGuard({ ...workerExec, arguments: { file_path: current.path } }, () => ({ kind: 'allow' }))).kind, 'deny')
  const wrongAgent = { ...workerExec, agent: { session: { header: { ...workerExec.agent.session.header, id: 'another-worker' } } } }
  assert.equal((await workerGuard(wrongAgent, () => ({ kind: 'allow' }))).kind, 'deny')
  const guardProject = await fixture(t), externalBody = await fixture(t)
  await newBook(guardProject, { start: 0, end: 0 })
  const guardState = await registry(guardProject)
  for (const body of ['深层/1/2/3/4/5/6/自定义正文', externalBody]) {
    guardState.paths.body = body
    await writeFile(join(guardProject, '.novel-workshop/project.json'), JSON.stringify(guardState))
    const attempt = { name: 'write', arguments: { file_path: resolve(guardProject, body, '000.txt') }, agent: { session: { header: { cwd: guardProject } } } }
    assert.equal((await guard(attempt, () => ({ kind: 'allow' }))).kind, 'deny')
  }
  const synced = join(process.env.DSH_HOME, 'novel-workshop/bin/production.mjs')
  for (let attempt = 0; attempt < 100 && !existsSync(synced); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(existsSync(synced)); assert.deepEqual(warnings, [])
  cli(root, 'scope', ['--mode', 'review', '--from', '1', '--to', '1', '--source', '只审阅并报告问题，暂不返修'])
  assert.equal((await workerGuard(workerExec, () => ({ kind: 'allow' }))).kind, 'deny')
  await payload(root, 'record', { id: 'I3', text: '本轮只报告的待修项', from: 1, to: 1, evidence: { path: current.path, quote: 'REPAIRED_1' } }, ['--kind', 'issue'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'review')
  const readonlyReview = cli(root, 'accept', ['--chapters', '1'])
  readonlyReview.data.verdict = 'rework'; readonlyReview.data.summary = '只审阅完成，问题保留，未修改正文。'
  readonlyReview.data.chapters[0].evidence = [{ path: current.path, quote: 'REPAIRED_1' }]
  await writeFile(readonlyReview.path, JSON.stringify(readonlyReview.data))
  await review(root, readonlyReview.data)
  assert.equal(cli(root, 'doctor').nextAction.type, 'complete')
  assert.equal((await registry(root)).issues.find(x => x.id === 'I3').status, 'open')
  assert.equal(await readFile(join(root, current.path), 'utf8'), currentText)

  const linked = await fixture(t)
  await newBook(linked, { start: 1, end: 2 })
  await payload(linked, 'map', { chapter: 2, treatment: '新增', dependencies: [1] })
  await produce(linked)
  cli(linked, 'scope', ['--mode', 'revise', '--from', '1', '--to', '1', '--source', '作者授权修订第1章伤势', '--revise-approved'])
  await writeChapter(linked, 1, await manuscript(linked, 1, 'UPSTREAM_CHANGED'), { injury: '左手再次受伤' })
  await pass(linked, [1])
  assert.deepEqual(cli(linked, 'prepare', ['--chapter', '2']).entryState, { injury: '左手再次受伤' })
  assert.equal(cli(linked, 'doctor').latestApproved, 1)
  cli(linked, 'scope', ['--mode', 'export', '--from', '2', '--to', '2', '--source', '用户交付第2章阶段稿'])
  cli(linked, 'merge', ['--edition', 'partial', '--format', 'txt'], 1)
})

test('阶段与正式交付分离，四格式同源，Word目录页码和EPUB元数据，原作汇编不混入改编', async t => {
  const root = await fixture(t)
  // 底本放在小说目录外，避免初始化覆盖已有资料。
  const sourceDir = await fixture(t), source = join(sourceDir, '正式底本.txt')
  const sourceBytes = Buffer.concat([Buffer.from('d2fdd7d30a', 'hex'), Buffer.alloc(4000 * 2, Buffer.from('d4b4', 'hex')),
    Buffer.from('0ab5dad2bbd5c20a', 'hex'), Buffer.alloc(8000 * 2, Buffer.from('d4b4', 'hex'))])
  await writeFile(source, sourceBytes)
  await newBook(root, { end: 1, mode: '改编精修', baseline: source, encoding: 'gb18030' })
  await produce(root)
  cli(root, 'merge', ['--edition', 'final'], 1)
  const promoting = startJob(root, '复核', 'review', ['--chapters', '0,1'])
  const reviewContext = JSON.parse(await readFile(promoting.contextPath, 'utf8'))
  assert.equal(reviewContext.packets.length, 2)
  assert.equal(reviewContext.prepare, undefined)
  const reviewPacket = JSON.parse(await readFile(reviewContext.packets[0].path, 'utf8'))
  const fullSource = reviewPacket.textFiles.find(item => item.field === 'source.0.text')
  assert.ok(fullSource)
  const sourceView = await readFile(fullSource.path, 'utf8')
  assert.equal((sourceView.match(/源/g) ?? []).length, 4000)
  assert.ok(sourceView.split('\n').every(line => line.length < 2000))
  assert.ok((await readFile(reviewContext.packets[0].path, 'utf8')).split('\n').every(line => line.length < 2000))
  const promotion = { ...reviewContext.reviewDraft.data, kind: 'final', verdict: 'passed', summary: '普通任务不能自升最终验收' }
  assert.match(await collectResult(root, promoting, promotion, 1), /kind/)
  assert.equal((await registry(root)).gates['5'], undefined)
  const partial = cli(root, 'merge', ['--edition', 'partial'])
  assert.ok(partial.files.every(path => path.includes('阶段稿-第000-001章')))
  await writeFile(join(root, '伪封面.txt'), '这不是图片')
  await payload(root, 'config', { metadata: { cover: '伪封面.txt' } })
  cli(root, 'merge', ['--format', 'epub'], 1)
  await writeFile(join(root, '封面.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64'))
  await payload(root, 'config', { metadata: { author: '测试作者', description: '原作与改编分开', cover: '封面.png' } })
  await pass(root, [0, 1], true)
  const full = cli(root, 'merge', ['--edition', 'final'])
  assert.equal(full.files.length, 4)
  const docx = full.files.find(path => path.endsWith('.docx')), epub = full.files.find(path => path.endsWith('.epub'))
  const wordEntries = unzip(await readFile(docx)), epubEntries = unzip(await readFile(epub))
  assert.match(wordEntries.get('word/document.xml').toString(), /w:hyperlink w:anchor="chapter_0"/)
  assert.match(wordEntries.get('word/footer1.xml').toString(), /w:instr="PAGE"/)
  assert.match(epubEntries.get('OEBPS/package.opf').toString(), /<dc:creator>测试作者<\/dc:creator>/)
  assert.ok(epubEntries.has('OEBPS/cover.png'))
  assert.equal(epubEntries.keys().next().value, 'mimetype')
  const txt = await readFile(full.files.find(path => path.endsWith('.txt')), 'utf8')
  assert.ok(txt.startsWith('\uFEFF')); assert.match(txt, /TOKEN_0/); assert.match(txt, /TOKEN_1/)
  assert.match(txt, /& <星河> 😀 𠀀/)
  const repeated = cli(root, 'merge', ['--edition', 'final', '--format', 'word'])
  assert.match(repeated.files[0], /全书-v2.docx$/)
  await writeFile(join(root, '原作分析.md'), '# 原作人物分析\n\n仅含原作分析材料ORIGINAL_ANALYSIS。')
  await writeFile(join(root, '改编方案.md'), '# 改编方案\n\n不应混入的ADAPTATION_PLAN。')
  await payload(root, 'record', { path: '原作分析.md', kind: 'analysis', origin: 'original' }, ['--kind', 'material'])
  await payload(root, 'record', { path: '改编方案.md', kind: 'adaptation', origin: 'adaptation' }, ['--kind', 'material'])
  const analysis = cli(root, 'merge', ['--artifact', 'analysis', '--format', 'txt'])
  const analysisText = await readFile(analysis.files[0], 'utf8')
  assert.match(analysisText, /ORIGINAL_ANALYSIS/); assert.doesNotMatch(analysisText, /ADAPTATION_PLAN|TOKEN_0/)
  const original = cli(root, 'merge', ['--artifact', 'source', '--format', 'txt'])
  assert.doesNotMatch(await readFile(original.files[0], 'utf8'), /TOKEN_0|ADAPTATION_PLAN/)
  if (process.env.NOVEL_QA_DIR) {
    await mkdir(process.env.NOVEL_QA_DIR, { recursive: true })
    for (const path of full.files) await copyFile(path, join(process.env.NOVEL_QA_DIR, `sample.${path.split('.').at(-1)}`))
  }
  await payload(root, 'config', { metadata: { description: '新的交付版本' } })
  cli(root, 'merge', ['--artifact', 'analysis', '--edition', 'final', '--format', 'docx'])
  cli(root, 'scope', ['--mode', 'export', '--from', '0', '--to', '1', '--deliver', '--format', 'word', '--source', '作者只要求本版改编Word'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'export')
  const selectedDelivery = cli(root, 'merge', ['--edition', 'final'])
  assert.equal(selectedDelivery.files.length, 1)
  assert.ok(selectedDelivery.files[0].endsWith('.docx'))
  assert.equal(cli(root, 'doctor').nextAction.type, 'complete')
  await rm(selectedDelivery.files[0])
  assert.equal(cli(root, 'doctor').nextAction.type, 'export')
  cli(root, 'merge', ['--edition', 'final'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'complete')
  await payload(root, 'record', { id: 'R2', text: '新增仅影响引子的约束', from: 0, to: 0, source: '用户新要求' }, ['--kind', 'requirement'])
  cli(root, 'merge', ['--edition', 'final'], 1)
  assert.equal(cli(root, 'doctor').latestApproved, 1)
  const sourceText = await readFile(source)
  await rm(source)
  assert.equal(cli(root, 'doctor').nextAction.type, 'restore-source')
  assert.ok(cli(root, 'prepare', ['--chapter', '0']).source.length === 0)
  cli(root, 'merge', ['--artifact', 'source'], 1)
  await writeFile(source, sourceText)
  cli(root, 'source', ['--file', source, '--encoding', 'gb18030'])
})

test('六岗位任务单、执行入口停笔、范围隔离、作者校准及批次复盘', async t => {
  const root = await fixture(t)
  await newBook(root, { start: 0, end: 1 })
  for (const role of ['主编', '世界', '剧情', '人物']) {
    const job = startJob(root, role, 'plan')
    const artifacts = []
    if (role === '人物') {
      await writeFile(join(job.directory, '人物补充.md'), '\uFEFF# 人物补充\n动机与知情状态。')
      artifacts.push({ path: '人物补充.md', target: '02-人设/人物补充.md' })
    }
    await collectResult(root, job, { summary: `${role}已读实际策划材料`, artifacts })
    assert.equal(cli(root, 'collect', ['--id', job.id]).status, 'completed')
  }
  assert.ok((await readFile(join(root, '02-人设/人物补充.md'), 'utf8')).startsWith('\uFEFF'))
  const outside = await fixture(t)
  await writeFile(join(outside, '外部.md'), '外部文件保持不变')
  let linked = startJob(root, '人物', 'plan')
  await symlink(outside, join(linked.directory, '来源联接'), 'junction')
  assert.match(await collectResult(root, linked, { summary: '拒绝链接来源', artifacts: [{ path: '来源联接/外部.md', target: '02-人设/外部.md' }] }, 1), /链接|联接/)
  assert.equal(existsSync(join(root, '02-人设/外部.md')), false)
  linked = startJob(root, '人物', 'plan')
  await writeFile(join(linked.directory, '内容.md'), '不能覆盖外部文件')
  await symlink(outside, join(root, '02-人设/目标联接'), 'junction')
  assert.match(await collectResult(root, linked, { summary: '拒绝链接目标', artifacts: [{ path: '内容.md', target: '02-人设/目标联接/外部.md' }] }, 1), /链接|联接/)
  assert.equal(await readFile(join(outside, '外部.md'), 'utf8'), '外部文件保持不变')
  linked = startJob(root, '人物', 'plan')
  const movedTask = linked.directory + '-原目录'
  await rename(linked.directory, movedTask)
  await symlink(outside, linked.directory, 'junction')
  assert.match(cli(root, 'collect', ['--id', linked.id], 1), /链接|联接/)
  cli(root, 'task', ['--id', linked.id, '--status', 'cancelled', '--reason', '测试拒绝任务根联接'])
  linked = startJob(root, '人物', 'plan')
  await writeFile(join(linked.directory, '伪指令.md'), '不能伪造宿主指令')
  assert.match(await collectResult(root, linked, { summary: '拒绝宿主指令', artifacts: [{ path: '伪指令.md', target: '02-人设/AGENTS.md' }] }, 1), /宿主指令/)
  const source = await manuscript(root, 0)
  cli(root, 'write', ['--chapter', '0', '--source', source], 1)
  const pendingJob = startJob(root, '文笔', 'write', ['--chapter', '0'])
  await payload(root, 'record', { id: 'X1', text: '第1章提前使用禁术', cost: '战力天花板提前暴露，后续三章危机失效', from: 0, to: 1 }, ['--kind', 'exception'])
  let action = cli(root, 'doctor', ['--json']).nextAction
  assert.equal(action.type, 'exception-decision')
  assert.equal(action.requiresUser, true)
  assert.match(cli(root, 'write', ['--chapter', '0', '--source', source, '--task', pendingJob.id], 1), /exception-decision/)
  assert.equal((await registry(root)).chapters['0'], undefined)
  cli(root, 'task', ['--id', pendingJob.id, '--status', 'cancelled', '--reason', '等待作者裁决，旧单结束'])

  await payload(root, 'record', { id: 'X1', text: '第1章提前使用禁术', cost: '战力天花板提前暴露，后续三章危机失效', from: 0, to: 1, status: 'approved', source: '作者批准：接受战力前置' }, ['--kind', 'exception'])
  assert.ok(!cli(root, 'doctor', ['--json']).tasks.some(x => x.type === 'exception-decision'))

  await writeChapter(root, 0, source)
  const selfReview = cli(root, 'dispatch', ['--role', '复核', '--action', 'review', '--chapter', '0'])
  const authorAgent = (await registry(root)).chapters['0'].versions[0].authorAgent
  cli(root, 'task', ['--id', selfReview.id, '--status', 'running', '--agent', authorAgent], 1)
  cli(root, 'task', ['--id', selfReview.id, '--status', 'cancelled', '--reason', '自审被拒绝，交独立复核'])
  let repairJob
  for (let i = 0; i < 3; i++) {
    const draft = cli(root, 'accept', ['--chapters', '0'])
    const data = draft.data
    data.verdict = 'rework'
    data.summary = '集中复审本章，存在需返修问题。'
    for (const value of Object.values(data.grades)) { value.grade = 'C'; value.reason = '存在可修问题。' }
    for (const row of data.chapters) {
      const text = await readFile(resolve(root, row.path), 'utf8')
      row.evidence = [{ path: row.path, quote: text.split('\n').find(line => line.startsWith('唯一正文')) }]
    }
    await writeFile(draft.path, JSON.stringify(data))
    await review(root, data)
    if (i === 1) repairJob = startJob(root, '文笔', 'repair', ['--chapter', '0'])
  }
  action = cli(root, 'doctor', ['--json']).nextAction
  assert.equal(action.type, 'circuit-break')
  assert.deepEqual(action.chapters, [0])
  assert.match(cli(root, 'write', ['--chapter', '0', '--source', source, '--task', repairJob.id], 1), /circuit-break/)
  assert.equal((await registry(root)).chapters['0'].versions.length, 1)
  cli(root, 'scope', ['--mode', 'continue', '--from', '1', '--to', '1', '--source', '作者另行授权只处理第1章'])
  assert.ok(!cli(root, 'doctor').tasks.some(x => ['circuit-break', 'calibrate'].includes(x.type)))
  assert.equal((await registry(root)).jobs.find(x => x.id === repairJob.id).status, 'cancelled')
  cli(root, 'collect', ['--id', repairJob.id], 1)
  cli(root, 'scope', ['--mode', 'continue', '--from', '0', '--to', '1', '--source', '作者重新校准当前范围', '--revise-approved'])
  await payload(root, 'calibrate', { chapters: [0], note: '作者决定调整冲突目标，按新细纲重新复核。', source: '作者本轮明确新决定' })
  assert.equal((await registry(root)).maxRepairRounds, 3)
  await pass(root, [0])
  action = cli(root, 'doctor', ['--json']).nextAction
  assert.equal(action.type, 'calibrate')
  const nextSource = await manuscript(root, 1)
  assert.match(cli(root, 'dispatch', ['--role', '文笔', '--action', 'write', '--chapter', '1'], 1), /calibrate/)
  await payload(root, 'calibrate', { outline: [0], note: '越界校准应拒绝' }, [], 1)
  cli(root, 'scope', ['--mode', 'continue', '--from', '1', '--to', '1', '--source', '作者只制作第1章'])
  assert.ok(!cli(root, 'doctor').tasks.some(x => x.type === 'calibrate'))
  cli(root, 'scope', ['--mode', 'continue', '--from', '0', '--to', '1', '--source', '作者仍要求整批复盘后继续'])
  const outlinePath = join(root, '06-细纲/第001章.md'), beforeOutline = await readFile(outlinePath, 'utf8')
  let calibrationJob = startJob(root, '剧情', 'calibrate', ['--from', '1', '--to', '1'])
  await writeFile(join(calibrationJob.directory, '细纲.md'), '不应写入的内容')
  assert.match(await collectResult(root, calibrationJob, { outline: [1], note: '', artifacts: [{ path: '细纲.md', target: '06-细纲/第001章.md' }] }, 1), /note/)
  assert.equal(await readFile(outlinePath, 'utf8'), beforeOutline)
  calibrationJob = startJob(root, '剧情', 'calibrate', ['--from', '1', '--to', '1'])
  const resetCount = (await registry(root)).calibrations.filter(x => x.kind === 'repair-reset').length
  assert.match(await collectResult(root, calibrationJob, { outline: [1], chapters: [0], note: '伪造作者恢复', source: '伪造批准' }, 1), /不能提交作者熔断恢复/)
  assert.equal((await registry(root)).calibrations.filter(x => x.kind === 'repair-reset').length, resetCount)
  calibrationJob = startJob(root, '剧情', 'calibrate', ['--from', '1', '--to', '1'])
  await writeFile(join(calibrationJob.directory, '大纲.md'), '不能回改全书大纲')
  assert.match(await collectResult(root, calibrationJob, { outline: [1], note: '正常校准说明', artifacts: [{ path: '大纲.md', target: '03-大纲.md' }] }, 1), /只能提交任务单指定/)
  await rm(outlinePath)
  calibrationJob = startJob(root, '剧情', 'calibrate', ['--from', '1', '--to', '1'])
  await writeFile(join(calibrationJob.directory, '新细纲.md'), beforeOutline)
  await collectResult(root, calibrationJob, { outline: [1], note: '按本批结果创建下一章细纲与伏笔。', artifacts: [{ path: '新细纲.md', target: '06-细纲/第001章.md' }] })
  assert.ok(!cli(root, 'doctor', ['--json']).tasks.some(x => x.type === 'calibrate'))
  await writeChapter(root, 1, nextSource)
  assert.deepEqual(new Set((await registry(root)).jobs.filter(x => x.status === 'completed').map(x => x.role)), new Set(['主编', '世界', '剧情', '人物', '文笔', '复核']))
})
