import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, copyFile, symlink, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), CLI = join(ROOT, 'bin/novel.mjs')
let sequence = 0
// DSH 0.2.1-rc.3 的强制 JSON Schema 子集；工具参数虽然当前不校验，但一旦宿主开始校验或走 PTC，超集写法会整体被拒。
const DSH_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const DSH_CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const DSH_ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples'])
function assertDshSchema(schema, path = 'schema') {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${path}必须是对象`)
  for (const key of Object.keys(schema)) assert.ok(DSH_CONSTRAINT_KEYS.has(key) || DSH_ANNOTATION_KEYS.has(key), `${path}.${key}不在DSH强制子集`)
  const hasType = Object.hasOwn(schema, 'type'), hasOneOf = Object.hasOwn(schema, 'oneOf')
  assert.ok(!(hasType && hasOneOf), `${path}不能同时声明type与oneOf`)
  if (!hasType && !hasOneOf) {
    for (const key of DSH_CONSTRAINT_KEYS) if (key !== 'type' && key !== 'oneOf') assert.ok(!Object.hasOwn(schema, key), `${path}.${key}需要type或oneOf`)
    return
  }
  if (hasOneOf) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) assert.ok(!Object.hasOwn(schema, key), `${path}.${key}不能与oneOf并存`)
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, `${path}.oneOf至少两个分支`)
    schema.oneOf.forEach((branch, index) => assertDshSchema(branch, `${path}.oneOf[${index}]`))
    return
  }
  assert.ok(typeof schema.type === 'string' && DSH_SCHEMA_TYPES.has(schema.type), `${path}.type必须是单个合法类型`)
  if (schema.type === 'object') {
    assert.ok(!Object.hasOwn(schema, 'items'), `${path}.items只能用于array`)
    if (Object.hasOwn(schema, 'properties')) {
      assert.ok(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), `${path}.properties必须是对象`)
      for (const [key, value] of Object.entries(schema.properties)) assertDshSchema(value, `${path}.properties.${key}`)
    }
    if (Object.hasOwn(schema, 'required')) {
      assert.ok(Array.isArray(schema.required), `${path}.required必须是数组`)
      for (const key of schema.required) assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${path}.required引用了未声明属性${key}`)
    }
    if (Object.hasOwn(schema, 'additionalProperties')) assert.equal(typeof schema.additionalProperties, 'boolean')
  } else if (schema.type === 'array') {
    assert.ok(!Object.hasOwn(schema, 'properties'), `${path}.properties只能用于object`)
    if (Object.hasOwn(schema, 'items')) assertDshSchema(schema.items, `${path}.items`)
  } else {
    for (const key of ['properties', 'required', 'additionalProperties', 'items']) assert.ok(!Object.hasOwn(schema, key), `${path}.${key}不能用于${schema.type}`)
  }
  if (Object.hasOwn(schema, 'enum')) assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0, `${path}.enum必须非空`)
}
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
async function pass(root, chapters, final = false, resolutions = [], expected = 0) {
  const draft = cli(root, 'accept', final ? ['--final'] : ['--chapters', chapters.join(',')])
  const data = draft.data
  data.verdict = 'passed'; data.summary = '集中读回本范围，并核对实际引文及前后承接。'
  if (resolutions.length) data.resolutions = resolutions
  for (const value of Object.values(data.grades)) { value.grade = 'B'; value.reason = '已结合本章原句和当前约束进行判断。' }
  for (const row of data.chapters) {
    row.outlineComplete = row.requirementsMet = row.logicChecked = row.styleChecked = true
    row.lengthReason = '场景与信息完整，篇幅仅作参照，没有填充重复段落。'
    const text = await readFile(resolve(root, row.path), 'utf8')
    row.evidence = [{ path: row.path, quote: text.split('\n').find(line => line.startsWith('唯一正文')) }]
  }
  await writeFile(draft.path, JSON.stringify(data))
  return review(root, data, expected)
}
async function produce(root, maximum = 45) {
  for (let step = 0; step < maximum; step++) {
    const action = cli(root, 'doctor', ['--json']).nextAction
    if (action.type === 'complete') return
    if (action.type === 'archive') { cli(root, 'archive'); continue }
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
  const native = JSON.parse(await readFile(join(ROOT, '.codex-plugin/plugin.json'), 'utf8'))
  assert.equal(native.name, 'tiancai-novel')
  assert.equal(native.version, '1.0.1')
  assert.equal(native.hooks, undefined)
  assert.equal(native.mcpServers, undefined)
  const nativeSkill = join(ROOT, native.skills, 'tiancai-novel')
  for (const match of (await readFile(join(nativeSkill, 'SKILL.md'), 'utf8')).matchAll(/\]\(([^)]+)\)/g)) assert.ok(existsSync(resolve(nativeSkill, match[1])))
  for (const dir of [nativeSkill, join(ROOT, 'skills/tiancai-novel')]) {
    assert.match(await readFile(join(dir, 'agents/openai.yaml'), 'utf8'), /policy:\s*\r?\n\s+allow_implicit_invocation: false/)
    assert.match(await readFile(join(dir, 'SKILL.md'), 'utf8'), /仅在用户明确调用/)
  }
  const nativeCatalog = JSON.parse(await readFile(join(ROOT, '.agents/plugins/marketplace.json'), 'utf8'))
  assert.equal(nativeCatalog.plugins[0].name, native.name)
  assert.equal(nativeCatalog.plugins[0].source.path, './')
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
  assert.match(first, /没有明确调用时/)
  assert.equal(existsSync(join(installed, '.novel-workshop/project.json')), false)
  const skillDir = join(installed, '.agents/skills/tiancai-novel'), skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  assert.equal(await readFile(join(skillDir, 'agents/openai.yaml'), 'utf8'), await readFile(join(nativeSkill, 'agents/openai.yaml'), 'utf8'))
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
  await mkdir(join(legacy, 'docs/设定'), { recursive: true })
  await mkdir(join(legacy, 'docs/归档'), { recursive: true })
  const characterPath = 'docs/设定/人物设定与关系.md', characterOriginal = '\uFEFF# 人物设定与关系\n\n甲：旧目标。\n\n其他人物与作者备注保留。\n'
  await writeFile(join(legacy, characterPath), characterOriginal)
  await mkdir(join(legacy, '创作笔记'), { recursive: true })
  await writeFile(join(legacy, '创作笔记/项目设想.md'), '# 创作目标\n已有立项不另建。')
  await writeFile(join(legacy, 'docs/设定/世界规则.md'), '# 世界规则\n已有规则不另建百科。')
  await writeFile(join(legacy, 'docs/归档/人物旧版.md'), '# 历史人物\n不用作当前依据。')
  await writeFile(join(legacy, 'docs/第三版文风应用说明.md'), '# 当前文风\n用动作呈现情绪。')
  await writeFile(join(legacy, 'docs/经验与注意事项.md'), '# 经验与注意事项\n作者现行规则保留。\n')
  const progressOriginal = '\uFEFF# 项目进度\n\nR35历史暂停与作者原要求保留。\n\n<!-- novel-workshop:progress:start -->\n## 工坊采用与正文登记\nR36人工说明：当前采用稿已换成数字TXT，旧通过不能代替新稿。\n<!-- novel-workshop:progress:end -->\n'
  await writeFile(join(legacy, 'docs/项目进度.md'), progressOriginal)
  await mkdir(join(legacy, '正文改编/片段'), { recursive: true })
  await writeFile(join(legacy, '正文改编/片段/362-2.txt'), '世界规则与人物身份只是正文对白。')
  await mkdir(join(legacy, 'docs/阅读工作底稿'), { recursive: true })
  await writeFile(join(legacy, 'docs/阅读工作底稿/章节细纲审查.md'), '# 章节细纲审查\n## 第1章\n历史候选，不能抢占执行。')
  await writeFile(join(legacy, 'docs/现行章节细纲.md'), '# 现行细纲\n## 第0章\n开场。\n## 第1章\n过河。\n## 第2章\n到岸。')
  const discovery = cli(legacy, 'doctor', ['--json'])
  assert.equal(discovery.nextAction.type, 'import')
  assert.equal(discovery.discovery.candidates[0].first, 0)
  assert.equal(discovery.discovery.differences[0].code, 'legacy-progress-mismatch')
  assert.equal(discovery.discovery.documents.targets.characters.path, characterPath)
  assert.equal(discovery.discovery.documents.targets.idea.path, '创作笔记/项目设想.md')
  assert.equal(discovery.discovery.documents.items, undefined)
  assert.ok(JSON.stringify(discovery).length < 10000)
  assert.equal(existsSync(join(legacy, '.novel-workshop/project.json')), false)
  cli(legacy, 'import', ['--interval', '10'])
  cli(legacy, 'config', ['--mode', '改编精修', '--length', 'source', '--source', '现行文档明确改编并按对应底本篇幅'])
  const state = await registry(legacy)
  assert.deepEqual(Object.keys(state.chapters), ['0', '1'])
  assert.equal(state.reviews.length, 0)
  assert.equal(state.documents.characters.path, characterPath)
  assert.equal(state.paths.notes, 'docs/经验与注意事项.md')
  assert.equal(state.paths.experience, state.paths.notes)
  assert.equal(await readFile(join(body, '000.txt'), 'utf8'), zero)
  assert.equal(cli(legacy, 'prepare', ['--chapter', '1']).length.target, 180)
  assert.equal(cli(legacy, 'prepare', ['--chapter', '2']).length.target, 70)
  assert.equal(cli(legacy, 'prepare', ['--chapter', '1']).outline.path, join(legacy, 'docs/现行章节细纲.md'))
  assert.equal(existsSync(join(legacy, '06-细纲/第001章.md')), false)
  await writeFile(join(legacy, 'docs/另一套章节细纲.md'), '# 另一套细纲\n## 第1章\n另一方案。\n## 第2章\n另一方案。')
  assert.match(cli(legacy, 'prepare', ['--chapter', '2'], 1), /多份细纲候选/)
  await payload(legacy, 'config', { outlines: [{ path: 'docs/现行章节细纲.md', from: 0, to: 2 }], source: '作者现行计划明确沿用该册0—2章' })
  assert.equal(cli(legacy, 'prepare', ['--chapter', '2']).outline.path, join(legacy, 'docs/现行章节细纲.md'))
  assert.equal(cli(legacy, 'documents', ['--query', '362-2']).total, 0)
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
  await payload(legacy, 'config', { documents: { style: 'docs/第三版文风应用说明.md' }, source: '读回现行说明后明确作为文风依据' })
  assert.equal((await registry(legacy)).documents.style.path, 'docs/第三版文风应用说明.md')
  assert.match(await payload(legacy, 'config', { documents: { characters: '正文改编/章节/001.md' }, source: '不能修改正文权限' }, [], 1), /不能把正式正文/)

  const catalog = cli(legacy, 'documents', ['--kind', 'characters'])
  assert.equal(catalog.items.filter(item => !item.archived).length, 1)
  cli(legacy, 'scope', ['--mode', 'revise', '--from', '1', '--to', '1', '--source', '作者允许复用并补充现有设定'])
  const worldPlanner = startJob(legacy, '世界', 'plan')
  await writeFile(join(worldPlanner.directory, '重复世界.md'), '# 重复的世界百科')
  assert.match(await collectResult(legacy, worldPlanner, { summary: '已有规则不另建', artifacts: [{ path: '重复世界.md', target: '01-世界.md' }] }, 1), /已有同用途文档/)
  assert.equal(existsSync(join(legacy, '01-世界.md')), false)
  let planner = startJob(legacy, '人物', 'plan')
  const planContext = JSON.parse(await readFile(planner.contextPath, 'utf8'))
  assert.equal(planContext.documents.targets[0].path, characterPath)
  await writeFile(join(planner.directory, '另建.md'), '# 重复人物档案')
  assert.match(await collectResult(legacy, planner, { summary: '不应重复创建', artifacts: [{ path: '另建.md', target: '02-人设/人物档案.md' }] }, 1), /已有同用途文档/)
  assert.equal(existsSync(join(legacy, '02-人设/人物档案.md')), false)
  planner = startJob(legacy, '人物', 'plan')
  await collectResult(legacy, planner, { summary: '原位补充甲的目标', artifacts: [{ target: characterPath, patches: [{ before: '甲：旧目标。', after: '甲：新目标。' }] }] })
  const revised = await readFile(join(legacy, characterPath), 'utf8')
  assert.equal(revised, characterOriginal.replace('旧目标', '新目标'))
  const unchangedStamp = await stat(join(legacy, characterPath))
  planner = startJob(legacy, '人物', 'plan')
  await writeFile(join(planner.directory, '原样.md'), revised)
  assert.deepEqual((await collectResult(legacy, planner, { summary: '现有成果可直接复用', artifacts: [{ target: characterPath, path: '原样.md' }] })).output.files, [])
  assert.equal((await stat(join(legacy, characterPath))).mtimeMs, unchangedStamp.mtimeMs)
  planner = startJob(legacy, '人物', 'plan')
  await writeFile(join(legacy, characterPath), revised + '\n作者在派单后补充的新决定。')
  assert.match(await collectResult(legacy, planner, { summary: '不能覆盖作者新决定', artifacts: [{ target: characterPath, patches: [{ before: '新目标', after: '另一目标' }] }] }, 1), /派单后发生变化/)
  await finish(legacy, 1)
  const combined = await readFile(join(legacy, 'docs/经验与注意事项.md'), 'utf8')
  assert.match(combined, /作者现行规则保留/); assert.match(combined, /记录实际持物/); assert.match(combined, /具体动作呈现场景/)
  assert.equal(existsSync(join(legacy, '07-注意事项.md')), false)
  assert.equal(existsSync(join(legacy, '08-经验文档.md')), false)
  const progress = await readFile(join(legacy, 'docs/项目进度.md'), 'utf8')
  assert.ok(progress.startsWith('\uFEFF# 项目进度'))
  assert.match(progress, /R35历史暂停与作者原要求保留/)
  assert.match(progress, /R36人工说明：当前采用稿已换成数字TXT/)
  assert.equal((progress.match(/同步前人工进度记录/g) ?? []).length, 1)
  assert.match(progress, /当前采用稿复核/)
  assert.match(progress, /实际落盘：2个位置/)
  assert.equal((progress.match(/novel-workshop:progress:start/g) ?? []).length, 1)
  const progressStamp = (await stat(join(legacy, 'docs/项目进度.md'))).mtimeMs
  await payload(legacy, 'config', { metadata: { language: 'zh-CN' } })
  assert.equal((await stat(join(legacy, 'docs/项目进度.md'))).mtimeMs, progressStamp)
  const ambiguous = join(dir, '多份文风候选')
  await mkdir(join(ambiguous, 'docs'), { recursive: true })
  await writeFile(join(ambiguous, 'docs/第一版文风.md'), '# 文风一\n待分析。')
  await writeFile(join(ambiguous, 'docs/第二版文风.md'), '# 文风二\n不得只按版本号选。')
  const choices = cli(ambiguous, 'documents', ['--kind', 'style'])
  assert.equal(choices.targets.style.status, 'choose'); assert.equal(choices.targets.style.path, null)
  assert.equal(existsSync(join(ambiguous, '.novel-workshop/project.json')), false)
  assert.equal(cli(ambiguous, 'doctor').nextAction.type, 'import')
  assert.equal(cli(ambiguous, 'import').imported, 0)
  assert.deepEqual(cli(ambiguous, 'doctor').nextAction.missing, ['mode', 'plan', 'length', 'interval'])
  await payload(ambiguous, 'config', { documents: { style: 'docs/第二版文风.md' }, source: '分析现行要求后选择，不由版本号推断' })
  assert.equal((await registry(ambiguous)).documents.style.path, 'docs/第二版文风.md')
  assert.equal(existsSync(join(ambiguous, '04-文风.md')), false)

  // dsh3：已登记为v3的数字TXT与旧v1/v2并存，不能按文件名再降为v1。
  const adopted = join(dir, '数字TXT采用稿')
  await newBook(adopted, { start: 1, end: 1 })
  const sample = await readFile(await manuscript(adopted, 1, 'ADOPTED'), 'utf8'), adoptedState = await registry(adopted)
  const versions = []
  for (const [index, name] of ['第001章-v1.md', '第001章-v2.md', '001.txt'].entries()) {
    const path = `09-正文/${name}`
    await writeFile(join(adopted, path), sample)
    const info = await stat(join(adopted, path))
    versions.push({ version: index + 1, path, words: 101, title: '采用稿', stamp: { size: info.size, mtime: info.mtimeMs }, receipt: null })
  }
  adoptedState.chapters['1'] = { sourceIds: [], treatment: '新增', dependencies: [], entities: [], factIds: [], versions }
  await writeFile(join(adopted, '.novel-workshop/project.json'), JSON.stringify(adoptedState))
  const manifestBeforeInspect = await readFile(join(adopted, '.novel-workshop/project.json'), 'utf8')
  const inspected = cli(adopted, 'doctor', ['--inspect'])
  assert.equal(inspected.nextAction.type, 'inspect-complete')
  assert.equal(inspected.productionStage, 'finish')
  assert.equal(inspected.currentChapters[0].version, 3)
  assert.equal(inspected.currentChapters[0].path, '09-正文/001.txt')
  assert.equal(inspected.currentChapters[0].approved, false)
  assert.equal(inspected.currentChapters[0].receipt, false)
  assert.equal(inspected.tasks.length, 0)
  assert.ok(!inspected.diagnostics.some(item => item.type === 'reconcile'))
  assert.equal(await readFile(join(adopted, '.novel-workshop/project.json'), 'utf8'), manifestBeforeInspect)
  assert.match(cli(adopted, 'doctor', ['--inspect', '--fix'], 1), /只读/)
  const repairedRegistry = cli(adopted, 'doctor', ['--fix'])
  assert.deepEqual(repairedRegistry.repair.registered, [])
  assert.equal(repairedRegistry.latestApproved, 0)
  assert.equal((await registry(adopted)).chapters['1'].versions.at(-1).path, '09-正文/001.txt')
  const pendingFinish = startJob(adopted, '文笔', 'finish', ['--chapter', '1'])
  await writeFile(join(adopted, '09-正文/第001章-v3.md'), sample + '\n未登记且无法推断采用的另一份稿。')
  assert.deepEqual(cli(adopted, 'doctor').tasks.find(item => item.type === 'reconcile').call, { action: 'doctor', options: { fix: true } })
  assert.match(cli(adopted, 'dispatch', ['--role', '文笔', '--action', 'finish', '--chapter', '1'], 1), /reconcile/)
  assert.match(await collectResult(adopted, pendingFinish, { notes: '不得绕过登记冲突', experience: '保持版本核对', exitState: {} }, 1), /reconcile/)
  assert.equal((await registry(adopted)).chapters['1'].versions.at(-1).receipt, null)
  assert.match(cli(adopted, 'doctor', ['--fix'], 1), /同一章节版本/)
  assert.equal((await registry(adopted)).chapters['1'].versions.length, 3)
  assert.equal(await readFile(join(adopted, '09-正文/001.txt'), 'utf8'), sample)
  cli(adopted, 'scope', ['--mode', 'review', '--from', '1', '--to', '1', '--source', '作者只读审阅，不补两更'])
  assert.match(cli(adopted, 'dispatch', ['--role', '文笔', '--action', 'finish', '--chapter', '1'], 1), /不允许文笔制作/)
})

test('doctor驱动单会话完整循环，自动两更与尾批复审，最新终点和暂停约束生效', async t => {
  const root = await fixture(t)
  await newBook(root, { end: 4 })
  await mkdir(join(root, '.novel-workshop/drafts'), { recursive: true })
  const reference = '.novel-workshop/drafts/仍需引用.md'
  await writeFile(join(root, reference), '当前仍使用的分析依据，归档后继续可读。')
  await payload(root, 'record', { path: reference, kind: 'analysis', origin: 'original' }, ['--kind', 'material'])
  const cleanupText = '\uFEFF# 本轮清理记录\n\n临时检查细节保持原字节。\n'
  await writeFile(join(root, '本轮清理记录.md'), cleanupText)
  await payload(root, 'record', { path: '本轮清理记录.md', kind: 'analysis', temporary: true, category: 'cleanup' }, ['--kind', 'material'])
  const outsideArchive = await fixture(t)
  await writeFile(join(outsideArchive, '保留.txt'), '不能移动外部文件')
  await mkdir(join(root, '.novel-workshop/drafts/含链接'), { recursive: true })
  await symlink(outsideArchive, join(root, '.novel-workshop/drafts/含链接/外部'), 'junction')
  const firstDraft = await manuscript(root, 0), keptJob = startJob(root, '文笔', 'write', ['--chapter', '0'])
  await writeFile(join(keptJob.directory, '完整草稿.md'), await readFile(firstDraft, 'utf8'))
  assert.equal(cli(root, 'archive', ['--preview']).ready, false)
  assert.match(cli(root, 'archive', [], 1), /未收件|未完成/)
  assert.ok(existsSync(keptJob.resultPath.replace('result.json', '完整草稿.md')))
  assert.deepEqual(cli(root, 'scope', ['--mode', 'continue', '--from', '0', '--to', '3', '--source', '用户中途将终点改为3']).jobs.kept, [keptJob.id])
  assert.deepEqual(cli(root, 'scope', ['--mode', 'continue', '--from', '0', '--to', '2', '--source', '最新终点2']).jobs.kept, [keptJob.id])
  await collectResult(root, keptJob, { draftFile: '完整草稿.md', title: '过河', notes: '记录实际持物、伤势与下一章承接。', experience: '用具体动作呈现场景，不重复规则说明。', exitState: { location: '河岸', next: '继续行程' } })
  await produce(root)
  let state = await registry(root)
  assert.deepEqual(Object.keys(state.chapters), ['0', '1', '2'])
  assert.equal(state.reviews.length, 2)
  assert.deepEqual(state.reviews[1].chapters.map(x => x.chapter), [2])
  assert.equal(cli(root, 'doctor').nextAction.type, 'complete')
  assert.ok(state.archives.length > 0)
  assert.equal(state.cleanupScope, state.scope.revision)
  assert.ok(existsSync(join(root, state.archives.at(-1).index)))
  assert.equal(existsSync(keptJob.directory), false)
  const archivedJob = cli(root, 'task', ['--id', keptJob.id])
  assert.ok(archivedJob.archivedIn)
  assert.ok(existsSync(archivedJob.resultPath))
  assert.equal(await readFile(join(archivedJob.directory, '完整草稿.md'), 'utf8'), await readFile(join(root, state.chapters['0'].versions[0].path), 'utf8'))
  const archivedContext = JSON.parse(await readFile(archivedJob.contextPath, 'utf8'))
  for (const input of archivedContext.requiredReads) assert.ok(existsSync(input.path), input.path)
  assert.equal(cli(root, 'collect', ['--id', keptJob.id]).status, 'completed')
  assert.ok(existsSync(join(root, reference)))
  const archivedMaterial = state.materials.find(item => item.temporary)
  assert.equal(archivedMaterial.status, 'archived')
  assert.match(archivedMaterial.path, /清理记录/)
  assert.equal(await readFile(join(root, archivedMaterial.path), 'utf8'), cleanupText)
  assert.equal(await readFile(join(outsideArchive, '保留.txt'), 'utf8'), '不能移动外部文件')
  assert.ok(existsSync(join(root, '.novel-workshop/drafts/含链接/外部')))
  const firstArchiveEntries = structuredClone(state.archives[0].entries)
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
  assert.deepEqual(state.archives[0].entries, firstArchiveEntries)
  await payload(root, 'config', { autoArchive: false })
  await writeFile(join(root, '.novel-workshop/drafts/最后临时稿.md'), '# 临时稿\n可追溯保存，不占工作目录。')
  const archivesBefore = (await registry(root)).archives.length
  const previewBefore = await readFile(join(root, '.novel-workshop/project.json'), 'utf8')
  assert.equal(cli(root, 'archive', ['--preview']).ready, true)
  assert.equal(await readFile(join(root, '.novel-workshop/project.json'), 'utf8'), previewBefore)
  assert.equal((await registry(root)).archives.length, archivesBefore)
  assert.ok(cli(root, 'archive').moved > 0)
  assert.equal(existsSync(join(root, '.novel-workshop/drafts/最后临时稿.md')), false)
  const archivesAfter = (await registry(root)).archives.length
  assert.equal(cli(root, 'archive').moved, 0)
  assert.equal((await registry(root)).archives.length, archivesAfter)
  assert.equal(cli(root, 'doctor').latestApproved, 5)
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
  draft.data.verdict = 'warned'
  await writeFile(draft.path, JSON.stringify(draft.data))
  await review(root, draft.data)
  assert.equal((await registry(root)).reviews.at(-1).verdict, 'rework')
  assert.equal((await registry(root)).issues[0].to, 1)
  assert.equal(cli(root, 'doctor').nextAction.type, 'repair')
  cli(root, 'scope', ['--mode', 'revise', '--from', '1', '--to', '1', '--source', '作者授权修订已有稿', '--revise-approved'])
  const repair = startJob(root, '文笔', 'repair', ['--chapter', '1'])
  const repairContext = JSON.parse(await readFile(repair.contextPath, 'utf8'))
  assert.equal(repairContext.manuscript.originalPath, join(root, original.path))
  assert.equal(repairContext.manuscript.version, original.version)
  const repairedQuote = quote.replace('TOKEN', 'REPAIRED')
  const patchResult = { patches: [{ before: quote, after: repairedQuote }], notes: '只修本段动作衔接。', experience: '保留其他场景和已修内容。', exitState: { location: '河岸', next: '继续行程' } }
  await writeFile(repair.resultPath, JSON.stringify(patchResult))
  const measured = cli(root, 'draft-check', ['--task', repair.id, '--file', repair.resultPath])
  assert.equal(measured.changeWords, 0)
  await collectResult(root, repair, patchResult)
  state = await registry(root)
  const current = state.chapters['1'].versions.at(-1), currentText = await readFile(join(root, current.path), 'utf8')
  assert.equal(currentText, originalText.replace(quote, repairedQuote))
  assert.equal(cli(root, 'doctor').nextAction.type, 'review')
  assert.equal(state.issues[0].status, 'open')
  assert.match(await pass(root, [1], false, [], 1), /未关闭阻塞问题/)
  assert.match(await pass(root, [1], false, [{ id: 'I1', status: 'resolved', resolution: '声称已修', evidence: { path: current.path, quote: '不存在的修复证据' } }], 1), /引文/)
  assert.equal((await registry(root)).issues[0].status, 'open')
  await payload(root, 'record', { id: 'I1', text: '本段动作衔接需补修', status: 'resolved', evidence: { path: current.path, quote: currentText.split('\n').find(line => line.startsWith('唯一正文')) } }, ['--kind', 'issue'], 1)
  await pass(root, [1], false, [{ id: 'I1', status: 'resolved', resolution: '独立读回新版，原问题已修复', evidence: { path: current.path, quote: repairedQuote } }])
  assert.equal((await registry(root)).issues[0].status, 'resolved')
  assert.ok((await registry(root)).issues[0].resolvedBy.agent)
  assert.equal(cli(root, 'prepare', ['--chapter', '1']).resolvedIssues[0].id, 'I1')
  assert.equal(await readFile(join(root, original.path), 'utf8'), originalText)
  await payload(root, 'record', { id: 'I2', text: '需要作者确认的取舍', from: 1, to: 1, requiresUser: true, evidence: { path: current.path, quote: 'REPAIRED_1' } }, ['--kind', 'issue'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'decision')
  await payload(root, 'record', { id: 'I2', text: '需要作者确认的取舍', status: 'retracted', resolution: '回查当前方案已明确，撤销误判' }, ['--kind', 'issue'])
  assert.equal(cli(root, 'doctor').nextAction.type, 'complete')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'dsh-home')
  t.after(() => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome })
  const hooks = await import(pathToFileURL(join(ROOT, 'adapters/dsh/hooks.js')).href + '?iteration')
  const handlers = new Map(), injected = [], warnings = [], coordinatorGuards = [], registeredTools = new Map()
  const ctx = { effect(fn) { return fn() }, on(name, fn) { handlers.set(name, fn); return () => {} }, systemPrompt: { section() { return () => {} } }, logger: { warn(x) { warnings.push(x) } },
    tools: { register(definition) { registeredTools.set(definition.name, definition); return () => {} }, guard(fn) { coordinatorGuards.push(fn); return () => {} } }, workingDirectory: { async ensure(agent) { return agent.session.header.cwd } },
    fs: { async resolve(path, options) { return { path: resolve(options.cwd ?? root, path) } }, processPath(target) { return target.path } }, agents: { get(id) { return { inject(message) { injected.push({ id, message }) } } } } }
  await hooks.apply(ctx)
  assert.equal(existsSync(join(root, 'dsh-home', 'novel-workshop', 'core', '手册.md')), true)
  const guard = handlers.get('tools/pre-execute'), exec = { name: 'write', arguments: { file_path: current.path }, agent: { session: { header: { cwd: root } } } }
  assert.equal((await guard(exec, () => ({ kind: 'allow' }))).kind, 'deny')
  assert.equal((await guard({ ...exec, name: 'edit' }, () => ({ kind: 'allow' }))).kind, 'deny')
  const notify = handlers.get('session/event')
  notify({ id: 'a' }, { type: 'compaction/end', data: { error: '失败' } })
  notify({ id: 'a' }, { type: 'compaction/end', data: {} }); notify({ id: 'b' }, { type: 'compaction/end', data: {} })
  assert.deepEqual(injected.map(x => x.id), ['a', 'b'])
  assert.equal((await guard({ ...exec, name: 'workflow' }, () => ({ kind: 'allow' }))).kind, 'deny')
  for (const name of ['pwsh', 'bash', 'run_code', 'subagent', 'send_message']) assert.equal((await guard({ ...exec, name }, () => ({ kind: 'allow' }))).kind, 'deny')
  const workerJob = startJob(root, '人物', 'plan'), workerState = await registry(root)
  const workerId = workerState.jobs.find(job => job.id === workerJob.id).agent
  const workerHandlers = new Map(), workerGuards = [], restrictions = [], presentations = []
  const fileTools = ['read', 'glob', 'grep', 'write', 'edit', 'novel_draft']
  const inheritedTools = new Set([...fileTools, 'pwsh', 'subagent', 'workflow', 'send_message'])
  let visibleTools = new Set(inheritedTools)
  const workerTools = {
    presentAs(mode) { presentations.push(mode); return () => {} },
    get(name) { return visibleTools.has(name) ? { name } : undefined },
    restrict(value) {
      for (const name of value.allow) assert.ok(inheritedTools.has(name), `未知继承工具：${name}`)
      restrictions.push(value)
      visibleTools = new Set([...visibleTools].filter(name => value.allow.includes(name)))
      return () => {}
    },
  }
  const toolAgent = { ctx: { tools: workerTools }, session: { header: { id: workerId } } }
  const workerCtx = { ...ctx, on(name, fn) { workerHandlers.set(name, fn); return () => {} },
    tools: {
      register() { return () => {} },
      presentAs() { assert.fail('展示模式须注册到worker实例，不是共享预设') },
      restrict() { assert.fail('不能在共享预设作用域限制本层文件工具') },
      guard(fn) { workerGuards.push(fn); return () => {} },
    },
    workingDirectory: { async ensure() { return root } },
    agents: { get(id) { return id === workerId ? toolAgent : id === 'captain' ? { session: { header: { id } } } : undefined } } }
  await hooks.apply(workerCtx, { worker: true })
  assert.deepEqual(presentations, []); assert.deepEqual(restrictions, [])
  workerHandlers.get('agent/created')({ agent: toolAgent, source: 'startup' })
  assert.deepEqual(presentations, ['native']); assert.deepEqual(restrictions, [{ allow: fileTools }])
  assert.deepEqual([...visibleTools], fileTools)
  // 标准会话首轮前切到小说预设：补发隔离；重复或别的预设事件不叠加。
  const latePresent = [], lateRestrict = []
  const lateTools = { presentAs(mode) { latePresent.push(mode); return () => {} }, restrict(value) { lateRestrict.push(value); return () => {} },
    get(name) { return fileTools.includes(name) ? { name } : undefined } }
  const lateAgent = { ctx: { tools: lateTools }, session: { header: { id: 'late-worker' } } }
  const originalGet = workerCtx.agents.get
  workerCtx.agents.get = id => id === 'late-worker' ? lateAgent : originalGet(id)
  const selected = workerHandlers.get('agent-preset/selected')
  assert.equal(typeof selected, 'function')
  selected('late-worker', 'tiancai-novel')
  assert.deepEqual(latePresent, [])
  selected('late-worker', 'tiancai-novel-worker')
  assert.deepEqual(latePresent, ['native'])
  assert.deepEqual(lateRestrict, [{ allow: fileTools }])
  selected('late-worker', 'tiancai-novel-worker')
  assert.equal(latePresent.length, 1); assert.equal(lateRestrict.length, 1)
  const workerExec = { name: 'write', arguments: { file_path: join(workerJob.directory, 'safe.md') },
    agent: { session: { header: { id: workerId, cwd: tmpdir(), origin: 'subagent', parentSession: 'captain' } } } }
  const workerGuard = workerHandlers.get('tools/pre-execute')
  assert.equal((await workerGuard(workerExec, () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal(workerGuards[0](workerExec), undefined)
  assert.equal((await workerHandlers.get('fs/write-intent')({ path: workerExec.arguments.file_path }, workerExec, () => ({ kind: 'allow' }))).kind, 'allow')
  // actor 缺省属于宿主内部写入，不应被小说守卫拦截。
  assert.equal((await workerHandlers.get('fs/write-intent')({ path: 'ignored' }, undefined, () => ({ kind: 'allow' }))).kind, 'allow')
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
  const unregisteredProject = await fixture(t)
  const outsideAttempt = { name: 'write', arguments: { file_path: join(unregisteredProject, '正文改编/章节/476.txt') },
    agent: { session: { header: { cwd: root } } } }
  assert.equal((await guard(outsideAttempt, () => ({ kind: 'allow' }))).kind, 'deny')
  await assert.rejects(handlers.get('fs/write-intent')({ path: outsideAttempt.arguments.file_path }, outsideAttempt, () => ({ kind: 'allow' })), /队长文件提交/)
  assert.equal((await guard({ ...outsideAttempt, arguments: { file_path: join(unregisteredProject, 'docs/笔记.md') } }, () => ({ kind: 'allow' }))).kind, 'deny')

  // 专用入口把真实启动/绑定合成一次；阅读由宿主回执证明，不能用聊天正文补交。
  const brokerRoot = await fixture(t)
  await newBook(brokerRoot, { start: 1, end: 2 })
  const brokerText = await manuscript(brokerRoot, 1, 'BROKER')
  const parent = { session: { header: { id: 'broker-captain', cwd: brokerRoot } } }
  const live = new Map([[parent.session.header.id, parent]]), children = new Map(), activations = []
  const brokerTools = new Map()
  const brokerCtx = { ...ctx, agents: { get(id) { return live.get(id) } },
    tools: { register(definition) { brokerTools.set(definition.name, definition); return () => {} }, guard() { return () => {} } },
    workingDirectory: { async ensure() { return brokerRoot } },
    subagents: { resolveMaxDepth(n) { return n }, async startActivation(spec) {
      activations.push(spec)
      const saved = await registry(brokerRoot), bound = saved.jobs.find(job => job.agent === spec.childId)
      assert.equal(bound.status, 'running'); assert.equal(bound.runtime, 'dsh-worker-v1')
      assert.equal(spec.request.agentPreset, 'tiancai-novel-worker'); assert.equal(spec.request.maxDepth, 1)
      const childHandlers = new Map(), childTools = new Map(), child = { session: { header: { id: spec.childId, cwd: brokerRoot, origin: 'subagent', parentSession: parent.session.header.id } } }
      const childCtx = { ...workerCtx, agents: brokerCtx.agents, workingDirectory: brokerCtx.workingDirectory,
        tools: { ...workerCtx.tools, register(definition) { childTools.set(definition.name, definition); return () => {} } },
        on(name, fn) { childHandlers.set(name, fn); return () => {} } }
      live.set(spec.childId, child); children.set(spec.childId, { child, handlers: childHandlers, tools: childTools })
      await hooks.apply(childCtx, { worker: true })
      return { childId: spec.childId }
    } } }
  await hooks.apply(brokerCtx)
  const workshop = brokerTools.get('novel_workshop'), brokerExec = { agent: parent, signal: new AbortController().signal }
  assertDshSchema(workshop.parameters, 'novel_workshop.parameters')
  assertDshSchema(workshop.output.schema, 'novel_workshop.output.schema')
  // OpenAI兼容供应商要求function parameters是object根；根级oneOf/anyOf会整单400。
  assert.equal(workshop.parameters.type, 'object')
  assert.equal(workshop.parameters.anyOf, undefined)
  assert.equal(workshop.parameters.oneOf, undefined)
  assert.ok(workshop.parameters.properties.data.properties.treatment.enum.includes('改写'))
  assert.equal(workshop.parameters.properties.options.properties.gate.type, 'integer')
  assert.equal(workshop.parameters.properties.action.enum.length, 18)
  assert.match(workshop.parameters.properties.options.description, /doctor:/)
  assert.match(workshop.parameters.properties.data.description, /config:/)
  await assert.rejects(workshop.execute({ action: 'config', data: { length: '按底本场景决定' } }, brokerExec), /length需要对象/)
  await assert.rejects(workshop.execute({ action: 'scope', data: { mode: 'pause' } }, brokerExec), /需要options/)
  await assert.rejects(workshop.execute({ action: 'config', data: { reviewInterval: 5 } }, brokerExec), /不支持reviewInterval/)
  await assert.rejects(workshop.execute({ action: 'doctor', fix: true }, brokerExec), /根参数不支持fix.*options/)
  const inspectBefore = await readFile(join(brokerRoot, '.novel-workshop/project.json'), 'utf8')
  const readOnlyDoctor = await workshop.execute({ action: 'doctor', options: { inspect: true } }, brokerExec)
  assert.equal(readOnlyDoctor.result.nextAction.type, 'inspect-complete')
  assert.equal(readOnlyDoctor.result.tasks.length, 0)
  await assert.rejects(workshop.execute({ action: 'dispatch', options: { role: '文笔', action: 'finish', chapter: 1 } }, brokerExec), /仅确认进度/)
  await assert.rejects(workshop.execute({ action: 'doctor', options: { fix: true } }, brokerExec), /仅确认进度/)
  await assert.rejects(workshop.execute({ action: 'archive' }, brokerExec), /仅确认进度/)
  assert.equal((await workshop.execute({ action: 'archive', options: { preview: true } }, brokerExec)).result.preview, true)
  await assert.rejects(workshop.execute({ action: 'doctor', options: { inspect: true, fix: true } }, brokerExec), /只读/)
  assert.equal(activations.length, 0)
  assert.equal(await readFile(join(brokerRoot, '.novel-workshop/project.json'), 'utf8'), inspectBefore)
  await workshop.execute({ action: 'doctor', options: { inspect: false } }, brokerExec)
  assert.equal((await registry(brokerRoot)).scope.mode, 'continue')
  await mkdir(join(unregisteredProject, '正文改编'), { recursive: true })
  await writeFile(join(unregisteredProject, '正文改编/进度.json'), JSON.stringify({ 已处理位置数: 0 }))
  // 相对项目路径按会话工作目录解析，而不是宿主进程 cwd。
  const relativeDoctor = await workshop.execute({ action: 'doctor', project: '.' }, brokerExec)
  assert.ok(relativeDoctor.result)
  const existingDocs = await workshop.execute({ action: 'documents', options: { kind: 'style' } }, brokerExec)
  assert.equal(existingDocs.result.targets.style.path, '04-文风.md')
  const legacyDoctor = await workshop.execute({ action: 'doctor', project: unregisteredProject }, brokerExec)
  assert.deepEqual(legacyDoctor, JSON.parse(JSON.stringify(legacyDoctor)))
  for (const text of ['记录已有要求', '作者更新要求']) {
    const recorded = await workshop.execute({ action: 'record', project: brokerRoot, options: { kind: 'requirement' }, data: { id: 'BR1', text, source: '作者明确要求' } }, brokerExec)
    assert.deepEqual(recorded, JSON.parse(JSON.stringify(recorded)))
  }
  await assert.rejects(workshop.execute({ action: 'write', project: brokerRoot }, brokerExec), /不支持/)
  await assert.rejects(workshop.execute({ action: 'task', project: brokerRoot, options: { id: 'job-0001', status: 'running', agent: 'fake' } }, brokerExec), /自动绑定/)
  await assert.rejects(workshop.execute({ action: 'dispatch', project: unregisteredProject, options: { role: '文笔', action: 'write', chapter: 1 } }, brokerExec))
  const start = await workshop.execute({ action: 'dispatch', project: brokerRoot, options: { role: '文笔', action: 'write', chapter: 1 } }, brokerExec)
  const started = start.result, writer = children.get(started.agent)
  assertDshSchema(writer.tools.get('novel_draft').parameters, 'novel_draft.parameters')
  assertDshSchema(writer.tools.get('novel_draft').output.schema, 'novel_draft.output.schema')
  assert.equal((await workshop.execute({ action: 'dispatch', project: brokerRoot, options: { role: '文笔', action: 'write', chapter: 1 } }, brokerExec)).waiting, true)
  assert.equal(activations.length, 1)
  const writeExec = { name: 'write', agent: writer.child, arguments: { file_path: started.resultPath } }
  const writeGate = writer.handlers.get('tools/pre-execute')
  assert.equal((await writeGate(writeExec, () => ({ kind: 'allow' }))).kind, 'deny')
  await writeFile(started.resultPath, JSON.stringify({ text: '聊天补交不能收件' }))
  await assert.rejects(workshop.execute({ action: 'collect', project: brokerRoot, options: { id: started.id } }, brokerExec), /阅读回执/)
  async function readMaterial(actor, path, count) {
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/)
    const value = { path, totalLines: lines.length, lines: lines.slice(0, count ?? lines.length).map((text, i) => ({ number: i + 1, text })) }
    return actor.handlers.get('tools/post-execute')({ name: 'read', agent: actor.child }, { isError: false, value }, () => ({ kind: 'accept' }))
  }
  async function readPacket(actor, path) {
    await readMaterial(actor, path)
    const packet = JSON.parse(await readFile(path, 'utf8'))
    for (const item of packet.textFiles ?? []) await readMaterial(actor, item.path)
    if (packet.manuscript?.path) await readMaterial(actor, packet.manuscript.path)
    for (const item of packet.packets ?? []) await readPacket(actor, item.path)
  }
  async function readTask(actor, job) {
    await readMaterial(actor, job.promptPath)
    await readMaterial(actor, join(ROOT, 'core/roles', `${job.role}.md`))
    await readPacket(actor, job.contextPath)
  }
  await readMaterial(writer, started.promptPath, 1)
  const missingReads = await writeGate(writeExec, () => ({ kind: 'allow' }))
  assert.equal(missingReads.kind, 'deny')
  assert.match(missingReads.reason, /一次列出全部缺项/)
  assert.ok(JSON.parse(await readFile(started.contextPath, 'utf8')).requiredReads.some(item => item.path === started.promptPath))
  await readTask(writer, started)
  assert.equal((await writeGate({ ...writeExec, arguments: { file_path: started.contextPath } }, () => ({ kind: 'allow' }))).kind, 'deny')
  assert.equal((await writeGate(writeExec, () => ({ kind: 'allow' }))).kind, 'allow')
  await writeFile(started.resultPath, JSON.stringify({ text: await readFile(brokerText, 'utf8'), notes: '据材料维护持物。', experience: '据材料维护经验。', exitState: { next: '已到本轮停止点' } }))
  const countedWrite = await writer.handlers.get('tools/post-execute')(writeExec, { isError: false }, () => ({ kind: 'accept' }))
  assert.match(countedWrite.additionalContexts[0].content[0].text, /"words":101/)
  assert.equal((await writer.handlers.get('tools/post-execute')(writeExec, { isError: true }, () => ({ kind: 'accept' }))).additionalContexts, undefined)
  const draftCount = await writer.tools.get('novel_draft').execute({ file_path: started.resultPath }, { agent: writer.child })
  assert.equal(draftCount.words, 101)
  const narrow = await workshop.execute({ action: 'scope', options: { mode: 'continue', from: 1, to: 1, source: '作者仅缩小终点，保留本章任务' } }, brokerExec)
  assert.deepEqual(narrow.result.jobs.kept, [started.id])
  assert.equal(narrow.result.reviseApproved, true)
  const readReceipt = JSON.parse(await readFile(join(brokerRoot, '.novel-workshop/read-receipts', `${started.id}.json`), 'utf8'))
  assert.equal(readReceipt.scopeRevision, narrow.result.revision)
  assert.equal((await writeGate(writeExec, () => ({ kind: 'allow' }))).kind, 'allow')
  await assert.rejects(writer.tools.get('novel_draft').execute({ file_path: brokerText }, { agent: writer.child }), /只能写入/)
  const collected = await workshop.execute({ action: 'collect', project: brokerRoot, options: { id: started.id } }, brokerExec)
  assert.equal(collected.result.status, 'completed'); assert.equal(collected.diagnosis.nextAction.type, 'review')
  assert.equal(collected.result.basis, undefined)
  assert.equal(collected.result.output.receipt, undefined)
  const reviewStart = await workshop.execute({ action: 'dispatch', project: brokerRoot, options: { role: '复核', action: 'review', chapters: [1] } }, brokerExec)
  const reviewJob = reviewStart.result, reviewer = children.get(reviewJob.agent)
  assert.notEqual(reviewJob.agent, started.agent)
  const reviewExec = { name: 'write', agent: reviewer.child, arguments: { file_path: reviewJob.resultPath } }
  assert.equal((await reviewer.handlers.get('tools/pre-execute')(reviewExec, () => ({ kind: 'allow' }))).kind, 'deny')
  await readTask(reviewer, reviewJob)
  const reviewData = JSON.parse(await readFile(reviewJob.contextPath, 'utf8')).reviewDraft.data
  assert.equal(reviewData.chapters[0].contract, undefined)
  assert.equal(reviewData.chapters[0].stamp, undefined)
  reviewData.verdict = 'passed'; reviewData.summary = '不同代理实际读回全文和材料。'
  for (const item of Object.values(reviewData.grades)) { item.grade = 'B'; item.reason = '结合实际正文与要求检查。' }
  const actual = (await registry(brokerRoot)).chapters['1'].versions.at(-1)
  for (const row of reviewData.chapters) {
    row.outlineComplete = row.requirementsMet = row.logicChecked = row.styleChecked = true
    row.lengthReason = '信息完整，无重复填充。'; row.evidence = [{ path: actual.path, quote: '唯一正文BROKER_1' }]
  }
  reviewData.issues = [{ from: 1, to: 1, severity: 'info', blocking: false, text: '可选建议：后续可调整节奏，不涉及当前逻辑和作者要求。', evidence: { path: actual.path, quote: '唯一正文BROKER_1' } }]
  assert.equal((await reviewer.handlers.get('tools/pre-execute')(reviewExec, () => ({ kind: 'allow' }))).kind, 'allow')
  await writeFile(reviewJob.resultPath, JSON.stringify(reviewData))
  const acceptedReview = await workshop.execute({ action: 'collect', project: brokerRoot, options: { id: reviewJob.id } }, brokerExec)
  assert.equal(acceptedReview.result.status, 'completed')
  assert.equal(acceptedReview.diagnosis.nextAction.type, 'complete')
  assert.equal(acceptedReview.diagnosis.latestReview.current, true)
  assert.equal(acceptedReview.result.archive.completed, true)
  assert.ok(acceptedReview.result.archive.categories.阅读回执 > 0)
  assert.ok(existsSync(acceptedReview.result.resultPath))
  const patchStart = await workshop.execute({ action: 'dispatch', options: { role: '文笔', action: 'repair', chapter: 1 } }, brokerExec)
  const patchJob = patchStart.result, patchWriter = children.get(patchJob.agent)
  const patchContext = JSON.parse(await readFile(patchJob.contextPath, 'utf8'))
  await readTask(patchWriter, patchJob)
  const patchGuard = patchWriter.handlers.get('tools/pre-execute')
  assert.equal((await patchGuard({ name: 'write', agent: patchWriter.child, arguments: { file_path: patchContext.manuscript.path } }, () => ({ kind: 'allow' }))).kind, 'deny')
  const patchExec = { name: 'write', agent: patchWriter.child, arguments: { file_path: patchJob.resultPath } }
  assert.equal((await patchGuard(patchExec, () => ({ kind: 'allow' }))).kind, 'allow')
  await writeFile(patchJob.resultPath, JSON.stringify({ patches: [{ before: '唯一正文BROKER_1', after: '唯一正文PATCHED_1' }], notes: '定点修订', experience: '保留未改段落', exitState: { next: '已到停止点' } }))
  assert.equal((await patchWriter.tools.get('novel_draft').execute({ file_path: patchJob.resultPath }, { agent: patchWriter.child })).changeWords, 0)
  const editExec = { ...patchExec, name: 'edit' }
  assert.equal((await patchGuard(editExec, () => ({ kind: 'allow' }))).kind, 'allow')
  const editedResult = JSON.parse(await readFile(patchJob.resultPath, 'utf8'))
  editedResult.patches[0].after += '星'
  await writeFile(patchJob.resultPath, JSON.stringify(editedResult))
  const countedEdit = await patchWriter.handlers.get('tools/post-execute')(editExec, { isError: false }, () => ({ kind: 'accept' }))
  assert.match(countedEdit.additionalContexts[0].content[0].text, /"changeWords":1/)
  assert.equal((await workshop.execute({ action: 'collect', options: { id: patchJob.id } }, brokerExec)).diagnosis.nextAction.type, 'review')
  const revokeJob = (await workshop.execute({ action: 'dispatch', options: { role: '文笔', action: 'repair', chapter: 1 } }, brokerExec)).result
  const revoked = await workshop.execute({ action: 'scope', options: { mode: 'continue', from: 1, to: 1,
    'revise-approved': false, source: '作者明确撤销既有修订授权，取消在跑的修订' } }, brokerExec)
  assert.equal(revoked.result.reviseApproved, false)
  assert.ok(revoked.result.jobs.cancelled.includes(revokeJob.id))
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

  // 跨批问题：局部复核不能让其他已修章节丢失待验状态。
  const multi = await fixture(t)
  await newBook(multi, { start: 1, end: 3 })
  for (const id of [1, 2, 3]) await manuscript(multi, id)
  await produce(multi)
  const spanning = cli(multi, 'accept', ['--chapters', '1,2,3']).data
  spanning.verdict = 'rework'; spanning.summary = '三章的持物交接需要同时修正。'
  for (const row of spanning.chapters) row.evidence = [{ path: row.path, quote: `TOKEN_${row.chapter}` }]
  spanning.issues = [{ from: 1, to: 1, text: '规则：跨章交接（1—3）。三章正文与出章状态需同步。', evidence: { path: spanning.chapters[0].path, quote: 'TOKEN_1' } }]
  await review(multi, spanning)
  assert.equal((await registry(multi)).issues.at(-1).to, 3)
  for (const id of [1, 2, 3]) {
    const job = startJob(multi, '文笔', 'repair', ['--chapter', String(id)])
    await collectResult(multi, job, { patches: [{ before: `TOKEN_${id}`, after: `FIXED_${id}` }], notes: '修正交接', experience: '保留相邻章约束', exitState: { location: '河岸', next: '继续行程' } })
  }
  assert.deepEqual(cli(multi, 'doctor').nextAction.chapters, [1, 2, 3])
  async function partialReview(id) {
    const data = cli(multi, 'accept', ['--chapters', String(id)]).data
    data.verdict = 'rework'; data.summary = '本章已读，跨章问题仍须完整范围复验。'
    data.chapters[0].evidence = [{ path: data.chapters[0].path, quote: `FIXED_${id}` }]
    delete data.resolutions // 遗留报告省略逐项状态，也须记录本章观察。
    await review(multi, data)
  }
  await partialReview(1)
  assert.deepEqual(cli(multi, 'doctor').tasks.find(task => task.type === 'repair').chapters, [1])
  cli(multi, 'scope', ['--mode', 'revise', '--from', '2', '--to', '3', '--source', '仅处理后两章'])
  assert.equal(cli(multi, 'doctor').nextAction.type, 'review-scope')
  cli(multi, 'scope', ['--mode', 'review', '--from', '1', '--to', '3', '--source', '逐章读回，只报告不改稿'])
  await partialReview(2); await partialReview(3)
  assert.equal(cli(multi, 'doctor').nextAction.type, 'complete')
})

test('阶段与正式交付分离，四格式同源，Word目录页码和EPUB元数据，原作汇编不混入改编', async t => {
  const root = await fixture(t)
  // 底本放在小说目录外，避免初始化覆盖已有资料。
  const sourceDir = await fixture(t), source = join(sourceDir, '正式底本.txt')
  const sourceBytes = Buffer.concat([Buffer.from('d2fdd7d30a', 'hex'), Buffer.alloc(4000 * 2, Buffer.from('d4b4', 'hex')),
    Buffer.from('0ab5dad2bbd5c20a', 'hex'), Buffer.alloc(8000 * 2, Buffer.from('d4b4', 'hex'))])
  await writeFile(source, sourceBytes)
  await newBook(root, { end: 1, mode: '改编精修', baseline: source, encoding: 'gb18030' })
  const volumeOutline = '# 卷说明\n保留共同约束。\n\n' + [0, 1, 8].map(id => `## 第${id}章\n${`第${id}章场景`.repeat(180)}\n${id < 2 ? `关联章号：第${id + 3}章。` : ''}\n`).join('\n')
  await writeFile(join(root, '卷细纲.md'), volumeOutline)
  await writeFile(join(root, '另一册.md'), '# 另一册共规\n保持资源来源。\n## 第三章\n第三章直接关联。关联章号：第九十九章。\n## 第四章\n第四章直接关联。\n## 第九十九章\n不递归展开这个章节。')
  for (const chapter of [0, 1]) await payload(root, 'map', { chapter, sourceIds: [chapter], treatment: '改写', outline: '卷细纲.md' })
  await produce(root)
  cli(root, 'merge', ['--edition', 'final'], 1)
  const promoting = startJob(root, '复核', 'review', ['--chapters', '0,1'])
  const reviewContext = JSON.parse(await readFile(promoting.contextPath, 'utf8'))
  assert.equal(reviewContext.packets.length, 2)
  assert.equal(reviewContext.prepare, undefined)
  const reviewPacket = JSON.parse(await readFile(reviewContext.packets[0].path, 'utf8'))
  const otherPacket = JSON.parse(await readFile(reviewContext.packets[1].path, 'utf8'))
  const outlineView = reviewPacket.textFiles.find(item => item.field === 'outline.text')
  const outlineText = await readFile(outlineView.path, 'utf8')
  assert.match(outlineText, /第0章/); assert.match(outlineText, /第1章/)
  assert.doesNotMatch(outlineText, /第8章场景/)
  assert.equal(reviewPacket.relatedOutlines.length, 1, JSON.stringify({ outline: reviewPacket.outline, missing: reviewPacket.missingRelatedChapters, files: await readdir(root) }))
  assert.match(reviewPacket.relatedOutlines[0].text, /第三章直接关联/)
  assert.doesNotMatch(reviewPacket.relatedOutlines[0].text, /第四章直接关联|不递归展开这个章节/)
  assert.match(otherPacket.relatedOutlines[0].text, /第四章直接关联/)
  assert.deepEqual(reviewPacket.missingRelatedChapters, [])
  assert.equal(reviewPacket.dependencies.relatedOutlines[0].path, '另一册.md')
  // 两章材料中完全相同的前章文本/公共长文本只生成一个阅读文件。
  const commonPaths = new Set(reviewPacket.textFiles.map(item => item.path))
  assert.ok(otherPacket.textFiles.some(item => commonPaths.has(item.path)))
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
      artifacts.push({ path: '人物补充.md', target: '02-人设/人物补充.md', createReason: '独立补充支线人物的动机与知情，不另建主档案' })
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
