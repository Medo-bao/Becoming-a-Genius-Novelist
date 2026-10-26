#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as P from './project.mjs'
import * as W from './production.mjs'
import * as T from './tasks.mjs'
import * as D from './documents.mjs'
import * as A from './archive.mjs'
import { bookFormats } from './book-formats.mjs'
import { safePath, managedPath } from './paths.mjs'

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'core')
function args(argv) {
  const positional = [], flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) positional.push(argv[i])
    else {
      const [key, ...value] = argv[i].slice(2).split('=')
      flags[key] = value.length ? value.join('=') : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }
  }
  return { positional, flags }
}
function output(value, json = true) { console.log(json ? JSON.stringify(value, null, 2) : value) }
const readPayloadFile = flags => typeof flags.source === 'string' ? P.jsonFile(resolve(flags.source)) : Promise.reject(new Error('需要 --source <JSON文件>'))
function formatList(value = 'all') {
  const list = [...new Set((Array.isArray(value) ? value : String(value).split(',')).map(v => v.trim().toLowerCase()).map(v => v === 'word' ? 'docx' : v))]
  if (list.some(v => !['all', 'md', 'txt', 'docx', 'epub'].includes(v))) throw new Error('format 支持 all、md、txt、docx、word、epub 或逗号组合')
  return list.includes('all') ? ['md', 'txt', 'docx', 'epub'] : list
}
function range(project, flags) {
  const from = P.integer(flags.from ?? project.scope.from), to = P.integer(flags.to ?? project.scope.to)
  if (to < from || from < project.start || to > project.end) throw new Error('章号范围超出项目计划')
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}
async function initialize(root, flags) {
  if (existsSync(P.local(root, P.MANIFEST))) throw new Error('已有项目登记，不能重复初始化；使用 config 或 import 新项目')
  const allowed = new Set(['.agents', '.codex', '.novel-workshop', 'AGENTS.md', 'AGENTS.override.md', '.git', '.gitignore', '.gitattributes'])
  if (existsSync(root) && (await readdir(root)).some(name => !allowed.has(name))) throw new Error('目录已有小说或其他文件，请用 import 接手，不覆盖内容')
  const start = P.integer(flags.start ?? 1), count = P.integer(flags.chapters ?? 120, '计划位置数', 1)
  const project = P.templateProject(root, { title: flags.title, mode: flags.mode === '改编' ? '改编精修' : flags.mode,
    start, end: flags.end ?? start + count - 1, words: flags.words, interval: flags.interval })
  if (!['原创', '改编精修'].includes(project.mode)) throw new Error('mode 只能为原创或改编精修')
  const provided = []
  if (flags.mode !== undefined) provided.push('mode')
  if (flags.start !== undefined && (flags.end !== undefined || flags.chapters !== undefined)) provided.push('plan')
  if (flags.words !== undefined && project.mode === '原创') provided.push('length')
  if (flags.length !== undefined) {
    if (!['fixed', 'source'].includes(flags.length)) throw new Error('length 为 fixed 或 source')
    if (flags.length === 'fixed' && flags.words === undefined) throw new Error('固定篇幅需要 --words')
    project.length.type = flags.length; provided.push('length')
  }
  if (flags.interval !== undefined) provided.push('interval')
  P.confirmParameters(project, provided, flags.source ?? '本次 init 显式参数')
  for (const dir of ['02-人设', project.paths.body, project.paths.outline, project.paths.reports, project.paths.output, '.novel-workshop/drafts']) await mkdir(await safePath(root, dir), { recursive: true })
  const positions = project.end - project.start + 1
  const tokens = { 书名: project.title, 渠道: project.mode, 卷数: flags.volumes ?? 3, 章数: positions, 章均字数: project.words, 验收间隔: project.interval,
    总字数: positions * project.words, 总万字: positions * project.words / 10000, 绿区下限: Math.ceil(project.words * .9), 绿区上限: Math.floor(project.words * 1.1), 项目目录: root, '001': P.pad(start), '005': P.pad(start + project.interval - 1) }
  const files = [['01-设想.md', '01-设想.md'], ['02-人物档案.md', '02-人设/人物档案.md'], ['03-大纲.md', '03-大纲.md'],
    ['04-文风.md', '04-文风.md'], ['05-总纲要.md', '05-总纲要.md'], ['06-细纲.md', `${project.paths.outline}/第${P.pad(start)}章.md`], ['07-注意事项.md', project.paths.notes], ['08-经验文档.md', project.paths.experience]]
  for (const [from, to] of files) await writeFile(await safePath(root, to), (await P.textFile(join(CORE, 'templates', from))).replace(/\{\{([^}]+)\}\}/g, (_, key) => String(tokens[key] ?? '')), { flag: 'wx' })
  if (flags.author) project.metadata.author = String(flags.author)
  if (typeof flags.baseline === 'string') project.source = await P.sourceIndex(root, flags.baseline, flags.encoding)
  await P.save(root, project)
  return { initialized: root, missingParameters: P.missingParameters(project), nextAction: '查明并确认缺失参数，登记已有用户授权 scope，再运行 doctor；规划完成后用 gate 记录依据' }
}
async function adopt(root, flags) {
  if (existsSync(P.local(root, P.MANIFEST))) throw new Error('项目已登记；用 doctor --fix 接续，禁止重复导入重置状态')
  const found = await P.discover(root), selected = flags.body ?? found.candidates[0]?.body ?? (found.hasPlanningDocuments ? '09-正文' : null)
  if (!selected) throw new Error('未找到章稿或可复用规划文档，请指定已有项目目录')
  const rows = await P.scan(root, selected)
  if (!rows.length && !found.hasPlanningDocuments) throw new Error('章稿目录为空，且未发现可复用规划文档')
  const legacy = found.legacy
  const start = P.integer(flags.start ?? rows[0]?.chapter ?? 1), end = P.integer(flags.end ?? (legacy?.totalPositions ? start + legacy.totalPositions - 1 : rows.at(-1)?.chapter ?? start + 119))
  const project = P.templateProject(root, { title: flags.title, mode: flags.mode === '原创' ? '原创' : '改编精修', start, end, words: flags.words, interval: flags.interval ?? legacy?.reviewInterval ?? 5 })
  if (flags.mode !== undefined && !['原创', '改编', '改编精修'].includes(flags.mode)) throw new Error('mode 只能为原创或改编精修')
  const explicit = []
  if (flags.mode !== undefined) explicit.push('mode')
  if (flags.start !== undefined && flags.end !== undefined) explicit.push('plan')
  else if (legacy?.totalPositions) P.confirmParameters(project, ['plan'], '现有进度登记的总位置数及实际起始章号')
  if (flags.interval !== undefined) explicit.push('interval')
  else if (legacy?.reviewInterval) P.confirmParameters(project, ['interval'], '现有进度登记的十章复审要求')
  if (flags.words !== undefined && project.mode === '原创') explicit.push('length')
  if (flags.length !== undefined) {
    if (!['fixed', 'source'].includes(flags.length) || flags.length === 'fixed' && flags.words === undefined) throw new Error('length 为 fixed 或 source；fixed 需要 --words')
    project.length.type = flags.length; explicit.push('length')
  }
  P.confirmParameters(project, explicit, flags.source ?? '本次 import 显式参数')
  project.paths.body = P.portable(root, P.local(root, selected))
  if (flags.outline) project.paths.outline = P.portable(root, P.local(root, flags.outline))
  if (flags.notes) project.paths.notes = P.portable(root, P.local(root, flags.notes))
  if (flags.experience) project.paths.experience = P.portable(root, P.local(root, flags.experience))
  const baseline = flags.baseline ?? legacy?.source
  if (baseline) project.source = await P.sourceIndex(root, baseline, flags.encoding ?? 'utf-8')
  await P.registerFiles(root, project)
  for (const path of found.references) project.materials.push({ id: `M${project.materials.length + 1}`, text: basename(path), title: basename(path), path,
    kind: 'adaptation', origin: 'adaptation', from: start, to: end, status: 'active', revision: 1 })
  await D.reuse(root, project, { skip: ['notes', 'experience'].filter(kind => flags[kind]) })
  await D.discoverProgress(root, project)
  if (existsSync(join(root, '00-状态.md'))) await copyFile(join(root, '00-状态.md'), await safePath(root, '.novel-workshop/接手前状态.md')).catch(async error => {
    if (error.code !== 'ENOENT') throw error
    await mkdir(P.local(root, '.novel-workshop'), { recursive: true }); await copyFile(join(root, '00-状态.md'), P.local(root, '.novel-workshop/接手前状态.md'))
  })
  await P.save(root, project)
  return { imported: P.chapterIds(project).length, range: [start, end], preservedOriginals: true, inheritedApprovals: 0,
    references: found.references, documents: project.documents, missingParameters: P.missingParameters(project), nextAction: '读取现行文档，复用已有规划，登记有效参数、要求、已有规划依据与本轮授权；历史稿件不自动视为已验收' }
}
async function setScope(root, project, flags) {
  const mode = flags.mode
  if (!['continue', 'review', 'revise', 'pause', 'export'].includes(mode)) throw new Error('scope mode 支持 continue、review、revise、pause、export')
  if (typeof flags.source !== 'string' || !flags.source.trim()) throw new Error('scope 必须记录用户本轮指示来源 --source')
  const from = P.integer(flags.from ?? (mode === 'continue' ? Math.min(P.nextChapter(project), project.end) : project.scope.from))
  const to = P.integer(flags.to ?? project.scope.to)
  if (from < project.start || to > project.end || to < from) throw new Error('授权范围超出计划')
  const previous = { ...project.scope }, previousInterval = project.interval
  const narrowed = mode === previous.mode && from >= previous.from && to <= previous.to && (from !== previous.from || to !== previous.to)
  project.scopeHistory.push({ ...previous, supersededAt: new Date().toISOString() })
  project.scope = { revision: project.scope.revision + 1, mode, from, to, source: flags.source,
    reviseApproved: flags['revise-approved'] === undefined && narrowed ? Boolean(previous.reviseApproved) : flags['revise-approved'] === true,
    deliver: flags.deliver === undefined && narrowed ? Boolean(previous.deliver) : flags.deliver === true,
    formats: formatList(flags.format ?? (narrowed ? previous.formats ?? 'all' : 'all')), time: new Date().toISOString() }
  if (flags.interval !== undefined) {
    project.interval = P.integer(flags.interval, '验收间隔', 1)
    P.confirmParameters(project, ['interval'], flags.source)
  }
  const jobs = await T.updateScopeJobs(root, project, previous, previousInterval)
  project.checkpoint = { time: new Date().toISOString(), scopeRevision: project.scope.revision, nextAction: 'doctor' }
  await P.save(root, project)
  return { ...project.scope, jobs }
}
async function mapChapter(root, project, data) {
  const chapter = P.integer(data.chapter)
  if (chapter < project.start || chapter > project.end) throw new Error('映射章号超出计划')
  if (!['保留', '改写', '合并', '删除', '新增', '校正', '联动'].includes(data.treatment)) throw new Error('需要明确 treatment：保留、改写、合并、删除、新增、校正、联动')
  const sourceIds = (data.sourceIds ?? []).map(n => P.integer(n))
  if (project.mode === '改编精修' && data.treatment !== '新增' && !sourceIds.length) throw new Error('改编映射需要 sourceIds')
  if (sourceIds.some(id => !project.source?.chapters[id])) throw new Error('sourceIds 不在底本索引中')
  const old = project.chapters[chapter]
  const baselineTreatment = old?.baselineTreatment && old.baselineTreatment !== '待核对' ? old.baselineTreatment : data.baselineTreatment ?? data.treatment
  const dependencies = [...new Set((data.dependencies ?? old?.dependencies ?? []).map(n => P.integer(n, '依赖章号')))].sort((a, b) => a - b)
  if (dependencies.some(n => n < project.start || n >= chapter)) throw new Error('依赖只能指向本项目中较早的章节')
  project.chapters[chapter] = { ...old, ...data, sourceIds, baselineTreatment,
    dependencies, factIds: data.factIds ?? old?.factIds ?? [], entities: data.entities ?? old?.entities ?? [], versions: old?.versions ?? [] }
  await P.save(root, project)
  return project.chapters[chapter]
}
async function configure(root, project, data) {
  const allowed = ['mode', 'plan', 'words', 'interval', 'length', 'maxRepairRounds', 'metadata', 'documents', 'outlines', 'progressFiles', 'autoArchive', 'source']
  for (const key of Object.keys(data)) if (!allowed.includes(key)) throw new Error(`config不支持${key}；使用mode、plan.start/end、length对象、interval及source`)
  if (data.length !== undefined && (!data.length || typeof data.length !== 'object' || Array.isArray(data.length))) throw new Error('length需要对象，例如{"type":"source","minRatio":null,"maxRatio":null}；不得传篇幅说明字符串')
  if (data.documents !== undefined) await D.bind(root, project, data.documents, data.source)
  if (data.autoArchive !== undefined) {
    if (typeof data.autoArchive !== 'boolean') throw new Error('autoArchive需要布尔值')
    project.autoArchive = data.autoArchive
  }
  if (data.progressFiles !== undefined) {
    if (!data.source?.trim()) throw new Error('绑定进度文档需要source说明项目维护要求')
    await D.bindProgress(root, project, data.progressFiles)
  }
  const keys = []
  if (data.mode !== undefined) {
    const mode = data.mode === '改编' ? '改编精修' : data.mode
    if (!['原创', '改编精修'].includes(mode)) throw new Error('mode 只能为原创或改编精修')
    project.mode = mode; keys.push('mode')
  }
  if (data.plan) {
    const start = P.integer(data.plan.start), end = P.integer(data.plan.end)
    if (end < start || Object.keys(project.chapters).map(Number).some(n => n < start || n > end)) throw new Error('全书范围不合法或排除了已有章节登记')
    const oldStart = project.start, oldEnd = project.end
    project.start = start; project.end = end
    if (project.scope.from === oldStart && project.scope.to === oldEnd) { project.scope.from = start; project.scope.to = end }
    else if (project.scope.from < start || project.scope.to > end) throw new Error('新全书范围排除了当前授权范围，先更新 scope')
    keys.push('plan')
  }
  if (data.words !== undefined) project.words = P.integer(data.words, '章均字数', 1)
  if (data.interval !== undefined) { project.interval = P.integer(data.interval, '验收间隔', 1); keys.push('interval') }
  if (data.maxRepairRounds !== undefined) project.maxRepairRounds = P.integer(data.maxRepairRounds, '熔断轮数', 1)
  if (data.metadata) project.metadata = { ...project.metadata, ...data.metadata }
  if (data.length) {
    const length = { type: project.length.type, minRatio: project.length.minRatio ?? null, maxRatio: project.length.maxRatio ?? null,
      ...(project.length.note ? { note: project.length.note } : {}), ...(project.length.source ? { source: project.length.source } : {}), ...data.length }
    for (const key of Object.keys(length)) if (!['type', 'minRatio', 'maxRatio', 'note', 'source'].includes(key)) throw new Error(`length不支持${key}`)
    if (!['fixed', 'source'].includes(length.type)) throw new Error('length.type 为 fixed 或 source')
    for (const key of ['minRatio', 'maxRatio']) if (length[key] !== null && (typeof length[key] !== 'number' || length[key] < 0)) throw new Error('篇幅比例边界为非负数或 null')
    if (length.minRatio !== null && length.maxRatio !== null && length.minRatio > length.maxRatio) throw new Error('最小篇幅比例不能大于最大值')
    project.length = length
    if (data.length.type !== undefined && (length.type === 'source' || data.words !== undefined || project.parameters.length?.source)) keys.push('length')
  }
  if (data.words !== undefined && project.length.type === 'fixed') keys.push('length')
  if (data.outlines !== undefined) await P.bindOutlines(root, project, data.outlines, data.source)
  P.confirmParameters(project, keys, data.source ?? '本次 config 显式参数')
  if (['mode', 'plan', 'words', 'interval', 'length', 'documents', 'outlines'].some(key => data[key] !== undefined)) {
    for (const job of project.jobs) if (['pending', 'running'].includes(job.status)) { job.status = 'cancelled'; job.reason = '制作参数已更新，保留结果后根据新材料重新派单' }
  }
  await P.save(root, project)
  return { words: project.words, interval: project.interval, maxRepairRounds: project.maxRepairRounds, length: project.length, metadata: project.metadata,
    documents: project.documents, outlines: project.outlines ?? [], progressFiles: project.progressFiles ?? [], autoArchive: project.autoArchive, missingParameters: P.missingParameters(project) }
}
async function merge(root, project, flags) {
  const artifact = String(flags.artifact ?? 'adaptation'), edition = String(flags.edition ?? 'partial')
  if (!['adaptation', 'source', 'analysis'].includes(artifact) || !['partial', 'final'].includes(edition)) throw new Error('artifact 为 adaptation/source/analysis；edition 为 partial/final')
  const chapters = []
  let from = project.start, to = Math.min(P.chapterIds(project).at(-1) ?? project.start, project.scope.to)
  if (artifact === 'adaptation') {
    if (edition === 'final') {
      if (!await W.finalApproved(root, project)) throw new Error('全书未完整或最终验收未通过，只能制作明确范围的阶段稿')
      to = project.end
    } else { from = P.integer(flags.from ?? project.scope.from); to = P.integer(flags.to ?? to) }
    if (from < project.start || to > project.end || to < from) throw new Error('导出范围不合法')
    const { approved } = await W.approvals(root, project)
    for (let id = from; id <= to; id++) {
      const row = approved.get(id)
      if (!row) throw new Error(`第${P.pad(id)}章缺少有效通过版本，先局部复验`)
      const text = await P.textFile(P.local(root, row.path))
      chapters.push({ ...row, chapter: id, text, ...P.chapterText(text, `第${P.pad(id)}章`) })
    }
  } else if (artifact === 'source') {
    if (!project.source || !P.sameStamp(project.source.stamp, await P.optionalStamp(P.local(root, project.source.path)))) throw new Error('底本文件/索引缺失或已变化，先按 doctor 恢复并更新 source')
    const sourceLines = (await P.textFile(P.local(root, project.source.path), project.source.encoding)).split(/\r?\n/)
    for (const id of Object.keys(project.source.chapters).map(Number).sort((a, b) => a - b)) {
      const slices = await P.sourceSlices(root, project, [id], sourceLines), text = slices.map(s => s.text).join('\n\n')
      chapters.push({ chapter: id, text, ...P.chapterText(text, project.source.chapters[id].title), name: project.source.path })
    }
  } else {
    for (const material of project.materials.filter(x => x.status === 'active' && x.kind === 'analysis' && x.origin === 'original')) {
      const text = await P.textFile(P.local(root, material.path))
      chapters.push({ text, ...P.chapterText(text, material.title ?? basename(material.path)), name: material.path })
    }
    if (!chapters.length) throw new Error('尚未登记原作分析资料，不能混用改编方案作原作汇编')
  }
  const formats = formatList(flags.format ?? project.scope.formats ?? 'all')
  const label = artifact === 'source' ? '原作底本' : artifact === 'analysis' ? '原作提炼汇编' : edition === 'final' ? '全书' : `阶段稿-第${P.pad(from)}-${P.pad(to)}章`
  const dir = await managedPath(root, project.paths.output, '.')
  await mkdir(dir, { recursive: true })
  const existing = await readdir(dir)
  const prior = project.exports.filter(row => row.artifact === artifact && (artifact !== 'adaptation' || row.edition === edition && row.range[0] === from && row.range[1] === to))
  let version = Math.max(0, ...prior.map(row => row.version)) + 1
  while (existing.some(n => n.startsWith(`${label}-v${version}.`) || n === `${label}-v${version}-目录.md`)) version++
  const book = { title: `${project.title}${artifact === 'adaptation' && edition === 'final' ? '' : ` · ${label}`}`, ...project.metadata,
    date: new Date(), chapters, total: chapters.reduce((sum, row) => sum + P.measure(row.text), 0) }
  if (project.metadata.cover && formats.includes('epub')) {
    const data = await readFile(P.local(root, project.metadata.cover))
    const type = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png' : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'image/jpeg' : null
    if (!type) throw new Error('EPUB封面需要真实的PNG或JPEG文件')
    book.cover = { data, type }
  } else book.cover = null
  const files = []
  for (const [extension, data] of bookFormats(book, formats)) {
    const path = await managedPath(root, project.paths.output, `${label}-v${version}.${extension}`)
    await writeFile(path, data, { flag: 'wx' }); files.push(path)
  }
  await writeFile(await managedPath(root, project.paths.output, `${label}-v${version}-目录.md`), `# ${book.title}\n\n${chapters.map(row => `- ${row.title}（${row.path ?? row.name}）`).join('\n')}\n`, { flag: 'wx' })
  project.exports.push({ artifact, edition, version, range: [from, to], files: files.map(p => P.portable(root, p)), projectContent: W.contentKey(project), time: new Date().toISOString() })
  await P.save(root, project)
  return { files, artifact, edition, chapters: chapters.length, words: book.total }
}
async function execute(argv, payload) {
  const readPayload = flags => payload === undefined ? readPayloadFile(flags) : Promise.resolve(payload)
  const { positional: [command, argument], flags } = args(argv)
  if (!command || command === 'help' || flags.help) {
    return `小说工坊：单会话队长与六岗位子代理

novel <命令> <项目目录> [选项]
  init       新书 --title --mode --start --chapters|--end --words --length fixed|source --interval
  import     接手既有目录 --body --baseline <底本> --encoding --start --end
  doctor     自动诊断、缺失参数、已有任务与下一步 --json [--fix|--inspect]
  documents  查找现有文档用途、标题与目录 --kind characters|style|... --query 关键词 [--offset N --limit N]
  status     进度与有效授权
  config     --source JSON；或 --source 用户依据 --mode --start --end --length --words --interval
  scope      --mode continue|review|revise|pause|export --from --to --source 用户指示 [--deliver] [--revise-approved]
  dispatch   六岗建单 --role 主编|世界|剧情|人物|文笔|复核 --action 动作 [--chapter N|--chapters 1,2|--from N --to N]
  task       查询任务；--id ID --status running --agent 实际子代理ID；failed|cancelled 需要 --reason
  collect    --id ID；收集子代理 result.json 并串行提交，队长不代写
  draft-check 文笔交稿前精确计量 --task ID --file 任务草稿或result.json（含patches）
  gate       --through 3 --evidence 文件 --source 已有批准依据
  source     建立/刷新底本索引 --file 文件 [--encoding utf-8|gb18030]
  map        底本映射与前章依赖 --source JSON
  record     要求/事实/问题/经验/资料/破格 --kind requirement|fact|issue|experience|material|exception --source JSON
  prepare    本章材料与诊断 --chapter N --json
  accept     生成独立复核草稿 --from --to [--final]
  write      已绑定任务故障恢复 --task ID --chapter N --source 草稿 [--revise-approved]
  finish     已绑定文笔任务的两更 --task ID --source JSON
  review     已绑定独立复核任务 --task ID --source JSON
  calibrate  批次复盘 --source JSON（outline/note）；作者熔断校准（chapters/note/source）
  checkpoint 保存接续说明 --source JSON
  check      集中检查实际状态
  archive    目标完成后分类归档过程资料；--preview [--offset N --limit N]只读预览
  merge      --artifact adaptation|source|analysis --edition partial|final --format all|txt|docx|epub|md`
  }
  if (!argument) throw new Error('缺少项目目录')
  const root = resolve(argument)
  if (command === 'doctor' && flags.inspect === true && flags.fix === true) throw new Error('doctor --inspect只读，不能同时使用--fix')
  if (command === 'documents') {
    const project = existsSync(P.local(root, P.MANIFEST)) ? await P.load(root) : null
    const found = await D.inventory(root, project), offset = P.integer(flags.offset ?? 0, '文档偏移'), limit = P.integer(flags.limit ?? 10, '文档页长', 1)
    const items = found.items.filter(item => (!flags.kind || item.kinds.includes(flags.kind)) && (!flags.query || (item.path + item.title + item.preview).includes(String(flags.query))))
    return { total: items.length, offset, items: items.slice(offset, offset + limit), targets: D.summary(found).targets, instruction: found.instruction }
  }
  if (command === 'init') return await initialize(root, flags)
  if (command === 'import') return await adopt(root, flags)
  if (command === 'doctor' && !existsSync(P.local(root, P.MANIFEST))) {
    const report = await W.diagnose(root)
    return flags.inspect === true ? W.inspectReport(report) : report
  }
  const project = await P.load(root)
  switch (command) {
    case 'doctor': {
      const repair = flags.fix ? await W.safeFix(root, project) : null
      const report = await W.diagnose(root, project)
      return flags.inspect === true ? W.inspectReport(report) : { ...report, ...(repair ? { repair } : {}) }
    }
    case 'status': return await W.diagnose(root, project)
    case 'scope': return await setScope(root, project, flags)
    case 'config': {
      const explicit = ['mode', 'start', 'end', 'words', 'interval', 'length'].some(key => flags[key] !== undefined)
      const data = explicit ? { source: flags.source, ...(flags.mode !== undefined ? { mode: flags.mode } : {}),
        ...(flags.start !== undefined || flags.end !== undefined ? { plan: { start: flags.start ?? project.start, end: flags.end ?? project.end } } : {}),
        ...(flags.words !== undefined ? { words: flags.words } : {}), ...(flags.interval !== undefined ? { interval: flags.interval } : {}),
        ...(flags.length !== undefined ? { length: { type: flags.length } } : {}) } : await readPayload(flags)
      if (explicit && (typeof flags.source !== 'string' || !flags.source.trim())) throw new Error('config 参数确认需要 --source 用户指示或文档依据')
      return await configure(root, project, data)
    }
    case 'source':
      if (typeof flags.file !== 'string') throw new Error('需要 --file 底本文件')
      project.source = await P.sourceIndex(root, flags.file, flags.encoding ?? 'utf-8')
      await P.save(root, project); return { indexed: Object.keys(project.source.chapters).length }
    case 'gate': {
      const through = P.integer(flags.through ?? flags.gate, '阶段门')
      if (through > 3 || typeof flags.evidence !== 'string' || !existsSync(P.local(root, flags.evidence)) || !flags.source) throw new Error('gate 需要0—3、存在的 evidence 文件及 source 批准依据')
      for (let n = flags.gate !== undefined ? through : 0; n <= through; n++) project.gates[n] = { passed: true, evidence: P.portable(root, P.local(root, flags.evidence)), source: flags.source }
      await P.save(root, project); return project.gates
    }
    case 'map': return await mapChapter(root, project, await readPayload(flags))
    case 'record': return await P.record(root, project, flags.kind, await readPayload(flags))
    case 'prepare': return await W.context(root, project, P.integer(flags.chapter ?? P.nextChapter(project)))
    case 'dispatch': return await T.dispatch(root, project, { ...flags, chapters: flags.chapters ? String(flags.chapters).split(',') : undefined })
    case 'task':
      if (!flags.id) return project.jobs.map(job => T.taskInfo(root, job))
      if (!flags.status) {
        const job = project.jobs.find(x => x.id === flags.id)
        if (!job) throw new Error('任务单不存在')
        return T.taskInfo(root, job)
      }
      return await T.updateTask(root, project, flags)
    case 'collect': return await T.collect(root, project, flags.id)
    case 'draft-check': return await T.inspectDraft(root, project, flags)
    case 'write':
      if (typeof flags.source !== 'string') throw new Error('需要 --source 草稿文件')
      return await W.writeChapter(root, project, P.integer(flags.chapter ?? P.nextChapter(project)), await P.textFile(resolve(flags.source)), flags['revise-approved'] === true, flags.task)
    case 'finish': return await W.finish(root, project, await readPayload(flags), flags.task)
    case 'accept': {
      const ids = flags.final ? Array.from({ length: project.end - project.start + 1 }, (_, i) => project.start + i) : flags.chapters ? String(flags.chapters).split(',').map(n => P.integer(n)) : range(project, flags)
      return await W.reviewDraft(root, project, ids, flags.final ? 'final' : 'batch')
    }
    case 'review': return await W.submitReview(root, project, await readPayload(flags), flags.task)
    case 'calibrate': return await P.calibrate(root, project, await readPayload(flags))
    case 'checkpoint':
      project.checkpoint = { ...await readPayload(flags), time: new Date().toISOString(), scopeRevision: project.scope.revision }
      await P.save(root, project); return project.checkpoint
    case 'check': {
      const diagnosis = await W.diagnose(root, project)
      return diagnosis
    }
    case 'merge': return await merge(root, project, flags)
    case 'archive': return await A.archive(root, project, { preview: flags.preview === true, offset: flags.offset, limit: flags.limit })
    default: throw new Error(`未知命令：${command}`)
  }
}
export async function run(argv, payload) {
  const result = await execute(argv, payload)
  const { positional: [command, argument], flags } = args(argv)
  const completion = ['collect', 'review', 'merge', 'finish', 'record', 'checkpoint', 'scope', 'config', 'calibrate', 'gate'].includes(command) ||
    command === 'task' && flags.status || command === 'doctor' && flags.fix === true
  if (!completion || !argument || flags.inspect === true) return result
  const root = resolve(argument), project = await P.load(root)
  if (project.autoArchive === false || project.scope.mode === 'pause' || project.jobs.some(job => ['pending', 'running'].includes(job.status))) return result
  if (['continue', 'revise'].includes(project.scope.mode)) {
    if (project.issues.some(issue => issue.status === 'open' && P.issueBlocks(issue) && issue.from <= project.scope.to && issue.to >= project.scope.from)) return result
    for (let id = project.scope.from; id <= project.scope.to; id++) {
      const current = P.latest(project, id), review = project.reviews.findLast(item => item.chapters.some(row => row.chapter === id))
      if (!current?.receipt || review?.verdict !== 'passed' || !review.chapters.some(row => row.chapter === id && row.version === current.version)) return result
    }
  }
  const report = await W.diagnose(root, project)
  if (!['complete', 'archive'].includes(report.stage) || project.jobs.some(job => ['pending', 'running'].includes(job.status))) return result
  const archived = await A.archive(root, project, { report })
  if (result?.id?.startsWith('job-')) {
    const job = project.jobs.find(item => item.id === result.id)
    return { ...result, ...T.taskInfo(root, job), ...(job.output ? { output: job.output } : {}), archive: archived }
  }
  if (command === 'record' && flags.kind === 'material') return { ...project.materials.find(item => item.id === result.id), archive: archived }
  if (command === 'doctor') return { ...await W.diagnose(root, project), ...(result.repair ? { repair: result.repair } : {}), archive: archived }
  return typeof result === 'object' && result ? { ...result, archive: archived } : result
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(process.argv.slice(2))
    output(result, typeof result !== 'string')
    if (process.argv[2] === 'check' && [...(result.tasks ?? []), ...(result.diagnostics ?? [])].some(x => ['configure', 'repair-record', 'repair-reference', 'repair-format', 'repair-length', 'reconcile', 'restore-source', 'reindex-source', 'refresh-evidence', 'resolve-gap', 'repair', 'decision', 'circuit-break', 'exception-decision'].includes(x.type))) process.exitCode = 1
  } catch (error) { console.error(`novel: ${error.message}`); process.exitCode = 1 }
}
