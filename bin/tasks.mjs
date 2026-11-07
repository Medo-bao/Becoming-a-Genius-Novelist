import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as P from './project.mjs'
import * as W from './production.mjs'
import { safePath, inside } from './paths.mjs'
import * as D from './documents.mjs'
import { runtime } from './runtime.mjs'
import { buildReviewReadings, readingText } from './review-materials.mjs'

const roles = {
  主编: ['plan', 'capture-requirements', 'decision'], 世界: ['plan', 'facts'], 人物: ['plan', 'facts'],
  剧情: ['plan', 'outline', 'map-source', 'calibrate'],
  文笔: ['write', 'repair', 'repair-length', 'repair-format', 'finish'], 复核: ['review', 'final-review']
}
export const nativeRuntimes = ['codex-native-v1', 'zcode-native-v1']
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'core')
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
async function writeContext(root, directory, target, value, shared = null) {
  const textFiles = [], textDirectory = await safePath(root, `${directory}/text`)
  async function materialize(item, field) {
    if (typeof item === 'string' && JSON.stringify(item).length > 1200) {
      let file = shared?.files.get(readingText(item))
      if (!file) {
        const storage = shared?.directory ?? textDirectory
        await mkdir(storage, { recursive: true })
        const path = await safePath(root, resolve(storage, `text-${(shared?.files.size ?? textFiles.length) + 1}.txt`)), text = readingText(item)
        await writeFile(path, text, 'utf8')
        file = { path, lines: text.split('\n').length - Number(text.endsWith('\n')), wrapped: true }
        shared?.files.set(text, file)
      }
      textFiles.push({ field, ...file })
      return `完整内容见 UTF-8 阅读文件：${file.path}`
    }
    if (Array.isArray(item)) {
      const copy = []
      for (let index = 0; index < item.length; index++) copy.push(await materialize(item[index], `${field}.${index}`))
      return copy
    }
    if (item && typeof item === 'object') {
      const copy = {}
      for (const [key, entry] of Object.entries(item)) copy[key] = await materialize(entry, field ? `${field}.${key}` : key)
      return copy
    }
    return item
  }
  const context = await materialize(value, '')
  await writeFile(await safePath(root, target), JSON.stringify({ ...context, textFiles,
    readingInstructions: 'textFiles中的完整内容均为UTF-8阅读视图，长行已分行，可用read的offset/limit分页；原文和正式文件不变。引用选择不跨新增换行的短句，正文证据使用manuscript.originalPath。' }, null, 2) + '\n', 'utf8')
}
async function manuscriptView(root, project, chapter, directory) {
  const version = P.latest(project, chapter), originalPath = P.local(root, version.path)
  const path = await safePath(root, resolve(directory, `${P.pad(chapter)}-body.txt`))
  await mkdir(dirname(path), { recursive: true })
  const content = readingText(await P.textFile(originalPath))
  await writeFile(path, content, 'utf8')
  return { path, originalPath, version: version.version, words: version.words, wrapped: true,
    lines: content.split('\n').length - Number(content.endsWith('\n')) }
}
export function formatManuscript(text, format) {
  if (!format || typeof format !== 'object' || Array.isArray(format) || !Object.keys(format).length ||
      Object.keys(format).some(key => !['heading', 'indent'].includes(key)) ||
      format.heading !== undefined && !['plain', 'markdown'].includes(format.heading) ||
      format.indent !== undefined && !['none', 'fullwidth'].includes(format.indent)) throw new Error('format仅支持heading:plain/markdown、indent:none/fullwidth，至少填一项')
  const newline = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/)
  const first = lines.findIndex(line => line.trim())
  if (first < 0 || !P.chapterText(text).title) throw new Error('当前稿缺少可识别的章题，不能仅靠排版生成章题')
  if (format.heading) {
    const title = lines[first].trimStart().replace(/^#{1,6}\s+/, '')
    lines[first] = (format.heading === 'markdown' ? '# ' : '') + title
  }
  if (format.indent) for (let i = first + 1; i < lines.length; i++) if (lines[i].trim()) {
    lines[i] = (format.indent === 'fullwidth' ? '　　' : '') + lines[i].replace(/^[\t \u3000]+/, '')
  }
  return lines.join(newline)
}
export function compareText(current, candidate) {
  const canonical = text => {
    const chapter = P.chapterText(text)
    // 只忽略章题井号、行首缩进和空行；保留段落边界、内部空格与标点。
    return chapter.title + '\n' + chapter.body.split('\n').map(line => line.replace(/^[\t \u3000]+|[\t \u3000]+$/g, '')).filter(Boolean).join('\n')
  }
  const before = [...canonical(current)], after = [...canonical(candidate)]
  let offset = 0
  while (offset < before.length && offset < after.length && before[offset] === after[offset]) offset++
  const sameContent = offset === before.length && offset === after.length, exactText = current === candidate
  return { exactText, formatOnly: !exactText && sameContent, contentChanged: !sameContent,
    ...(sameContent ? {} : { firstContentDifference: { offset, before: before.slice(Math.max(0, offset - 30), offset + 70).join(''), after: after.slice(Math.max(0, offset - 30), offset + 70).join('') } }) }
}
export async function writerText(root, project, job, data) {
  const repairing = ['repair', 'repair-length', 'repair-format'].includes(job.action)
  if (data.draftFile !== undefined) {
    if (typeof data.draftFile !== 'string' || data.text !== undefined || data.patches !== undefined || data.format !== undefined || !/\.(md|txt)$/i.test(data.draftFile)) throw new Error('draftFile需要任务内MD/TXT文件，与text、patches、format互斥')
    if (repairing && !data.rewriteReason?.trim()) throw new Error('返修默认提交patches；引用整章草稿也需rewriteReason')
    const path = await taskFile(root, job, data.draftFile)
    if ((await requiredInputs(root, job)).some(item => P.local(root, item.path) === path)) throw new Error('draftFile只能引用本任务产出的草稿，不能把只读输入当作创作结果')
    const text = await P.textFile(path)
    if (!text.trim()) throw new Error('草稿为空')
    return text
  }
  if (data.patches !== undefined || data.format !== undefined) {
    if (!repairing || data.text !== undefined || data.patches !== undefined && (!Array.isArray(data.patches) || !data.patches.length)) throw new Error('patches/format仅用于返修，不能同时提交text；patches至少有一处修改')
    const version = P.latest(project, currentChapter(job))
    if (!version || version.version !== job.basis[0].version) throw new Error('返修底稿版本已变化，重新派单')
    let text = await P.textFile(P.local(root, version.path))
    for (const patch of data.patches ?? []) {
      if (typeof patch.before !== 'string' || !patch.before || typeof patch.after !== 'string') throw new Error('每处patch需要非空before与字符串after')
      const anchor = patch.before.split(/\r?\n/).map(line => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n')
      const pattern = new RegExp(anchor, 'g'), match = pattern.exec(text)
      if (!match) throw new Error('返修before未在当前稿中找到，请从现稿重新复制原句')
      pattern.lastIndex = match.index + 1
      if (pattern.test(text)) throw new Error('返修before在当前稿中重复，请扩大原句范围')
      const newline = match[0].match(/\r?\n/)?.[0] ?? text.match(/\r?\n/)?.[0] ?? '\n'
      const replacement = patch.after.replace(/\r?\n/g, newline)
      text = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length)
    }
    return data.format === undefined ? text : formatManuscript(text, data.format)
  }
  if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('文笔结果缺少text正文或返修patches')
  if (repairing && !data.rewriteReason?.trim()) throw new Error('返修默认提交patches保留原稿；确需整章重写须提供rewriteReason说明')
  return data.text
}
export async function inspectDraft(root, project, data) {
  const role = project.jobs.find(job => job.id === data.task)?.role
  if (!['文笔', '复核'].includes(role)) throw new Error('计量需要绑定的文笔或复核任务单')
  const job = requireJob(project, data.task, role, undefined, role === '文笔' ? ['write', 'repair', 'repair-length', 'repair-format', 'finish'] : ['review', 'final-review'])
  const directory = await safePath(root, job.currentDirectory ?? job.directory)
  const path = await taskFile(root, job, data.file)
  const bodyChapters = job.chapters.filter(chapter => path === resolve(directory, `${P.pad(chapter)}-body.txt`) ||
    role === '复核' && [resolve(directory, 'chapters', `${P.pad(chapter)}-body.txt`), resolve(directory, 'chapters', `${P.pad(chapter)}-review.md`)].includes(path))
  if (job.action === 'finish' || role === '复核' || bodyChapters.length) {
    const resultFile = path === resolve(directory, 'result.json')
    if (resultFile) {
      if (job.action === 'finish') finishRows(job, await P.jsonFile(path))
      else await P.textFile(path)
    } else {
      if (!bodyChapters.length) throw new Error('现稿计量只接受本单result.json或当前正文阅读视图，不计量其他材料或另抄草稿')
      await P.textFile(path)
    }
    const chapters = resultFile ? job.chapters : bodyChapters
    const counts = []
    for (const chapter of chapters) {
      const current = P.latest(project, chapter)
      if (!current || current.version !== job.basis.find(row => row.chapter === chapter)?.version || !await P.versionValid(root, current)) throw new Error('当前章稿已变化，先核对任务版本')
      const words = P.measure(await P.textFile(P.local(root, current.path)))
      counts.push({ chapter, file: P.local(root, current.path), ...P.lengthInfo(project, chapter, words), currentWords: current.words, changeWords: 0 })
    }
    return { task: job.id, action: job.action, input: 'current-manuscript', unit: '正文汉字（Unicode Script=Han，不含章题）',
      ...(counts.length === 1 ? counts[0] : {}), chapters: counts, policy: project.length,
      instruction: '按当前正式稿精确计量，无须复制草稿或写探针。计量不代表文本相同或复核通过；未规定比例时不自行设95%等门槛。' }
  }
  if ((await requiredInputs(root, job)).some(item => item.path === path)) throw new Error('不能把底本或任务材料当作候选草稿计量；当前正文使用manuscript视图')
  const raw = await P.textFile(path)
  const text = path.endsWith('.json') ? await writerText(root, project, job, JSON.parse(raw)) : raw
  const chapter = currentChapter(job), words = P.measure(text), current = P.latest(project, chapter)
  return { task: job.id, chapter, file: path, ...P.lengthInfo(project, chapter, words), currentWords: current?.words ?? null,
    changeWords: current ? words - current.words : null, policy: project.length, unit: '正文汉字（Unicode Script=Han，不含章题）',
    ...(current ? { comparison: compareText(await P.textFile(P.local(root, current.path)), text) } : {}),
    instruction: '汉字数相同不证明内容相同，文本差异看comparison；不写探针推算口径。按场景与作者篇幅政策集中处理缺口，未规定比例时不自行设95%等门槛，不逐句补字凑比例。' }
}
export function requireJob(project, id, role, chapter, actions) {
  const job = project.jobs?.find(x => x.id === id)
  if (!job || job.role !== role || job.status !== 'running' || !job.agent || job.scopeRevision !== project.scope.revision ||
      chapter !== undefined && !job.chapters.includes(chapter) || actions && !actions.includes(job.action)) {
    throw new Error(`需要已绑定真实子代理的运行中${role}任务单 --task；队长只能派单与收集，不代写或自审`)
  }
  return job
}
function finishRows(job, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('finish结果需要对象')
  if (['text', 'draftFile', 'patches', 'format', 'rewriteReason'].some(key => Object.hasOwn(data, key))) W.validateReceipt(data, { metadataOnly: true })
  const rows = data.chapters === undefined && job.chapters.length === 1 ? [{ ...data, chapter: job.chapters[0] }] : data.chapters
  if (!Array.isArray(rows) || !equal(rows.map(row => row?.chapter).sort((a, b) => a - b), job.chapters)) throw new Error('finish结果的chapters必须逐章且不重复地覆盖任务全部章号')
  for (const row of rows) W.validateReceipt(row, { metadataOnly: true })
  return [...rows].sort((a, b) => a.chapter - b.chapter)
}
function within(base, path) {
  const rel = relative(base, resolve(base, path))
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('任务文件路径越出分配目录')
  return resolve(base, path)
}
async function taskFile(root, job, file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('需要任务文件路径')
  const directory = P.local(root, job.directory), current = P.local(root, job.currentDirectory ?? job.directory)
  const projectPath = P.local(root, file), jobPath = resolve(directory, file)
  const path = isAbsolute(file) || inside(directory, projectPath) ? projectPath : inside(current, jobPath) ? jobPath : resolve(current, file)
  await safePath(root, current)
  return safePath(current, within(current, path))
}
export const currentChapter = job => job.batch ? job.chapters[job.cursor ?? 0] : job.chapters[0]
export function batchKey(project, chapter) {
  return `${project.scope.revision}-${project.scope.from + Math.floor((chapter - project.scope.from) / project.interval) * project.interval}`
}
export function taskInfo(root, job) {
  const directory = job.currentDirectory ?? job.directory
  return { ...job, currentChapter: currentChapter(job), directory: P.local(root, job.directory), promptPath: P.local(root, `${directory}/prompt.md`),
    resultPath: P.local(root, `${directory}/result.json`), contextPath: P.local(root, `${directory}/context.json`) }
}

export async function taskContinuation(root, job) {
  const { id, role, action, chapters, agent, status, resultPath } = taskInfo(root, job)
  const task = { id, role, action, chapters, agent, status, result: resultPath }
  if (status === 'pending') return { ...task, next: 'start' }
  if (job.batch && job.committed.length === chapters.length) return { ...task, next: 'collect' }
  try {
    const result = await P.jsonFile(await safePath(root, resultPath))
    if (result && typeof result === 'object' && !Array.isArray(result)) return { ...task, next: job.batch ? 'chapter-commit' : 'collect' }
    return { ...task, next: 'invalid-result', resultIssue: '结果必须为 JSON 对象' }
  } catch (error) {
    if (error.code === 'ENOENT') return { ...task, next: 'check-worker' }
    if (error instanceof SyntaxError) return { ...task, next: 'invalid-result', resultIssue: '结果 JSON 不完整或无法解析' }
    return { ...task, next: 'result-unreadable', resultIssue: error.code ?? error.message }
  }
}
async function sharedMaterials(root, project, chapter) {
  const directory = await safePath(root, `.novel-workshop/batches/${batchKey(project, chapter)}/materials`)
  await mkdir(directory, { recursive: true })
  const files = new Map()
  for (const name of await readdir(directory)) if (/^text-\d+\.txt$/.test(name)) {
    const path = await safePath(root, resolve(directory, name)), text = await readFile(path, 'utf8')
    files.set(text, { path, lines: text.split('\n').length - Number(text.endsWith('\n')), wrapped: true })
  }
  return { directory, files }
}

async function savedReviewValid(root, project, job, scope) {
  if (job.action !== 'review' || !['continue', 'review', 'revise'].includes(scope.mode) || job.resultCorrection?.pending ||
      !job.chapters.length || job.chapters.some(chapter => chapter < scope.from || chapter > scope.to)) return false
  const candidate = { ...job, status: 'running' }
  const inspection = { ...project, scope: { ...scope, revision: job.scopeRevision },
    jobs: project.jobs.map(item => item === job ? candidate : item) }
  try { return (await inspectResult(root, inspection, job.id)).valid === true }
  catch { return false }
}

export async function updateScopeJobs(root, project, previous, previousInterval) {
  const kept = [], cancelled = [], paused = [], scope = project.scope, outlineCache = new Map()
  const contained = scope.from >= previous.from && scope.to <= previous.to
  for (const job of project.jobs.filter(item => ['pending', 'running', 'paused'].includes(item.status))) {
    const wasPaused = job.status === 'paused'
    if (scope.mode === 'pause' && (wasPaused || job.status === 'running' && job.scopeRevision === previous.revision && await savedReviewValid(root, project, job, previous))) {
      job.status = 'paused'
      job.reason = '独立复核结果已保存，恢复授权后重新核验材料并收件'
      paused.push(job.id)
      continue
    }
    const remaining = job.chapters.filter(id => !job.committed?.some(row => row.chapter === id))
    let valid = wasPaused ? await savedReviewValid(root, project, job, scope) : contained && scope.mode === previous.mode && !['pause', 'export'].includes(scope.mode) && project.interval === previousInterval &&
      scope.reviseApproved === Boolean(previous.reviseApproved) && ['文笔', '复核'].includes(job.role) && job.action !== 'final-review' &&
      job.scopeRevision === previous.revision && job.chapters.length > 0 && (job.batch ? remaining.filter(id => W.inScope(project, id)).length > 0 : job.chapters.every(id => W.inScope(project, id)))
    if (valid && !wasPaused) try {
      for (const basis of job.basis.filter(row => !job.committed?.some(item => item.chapter === row.chapter) && (!job.batch || W.inScope(project, row.chapter)))) if ((P.latest(project, basis.chapter)?.version ?? null) !== basis.version ||
        !P.sameContract(batchContract(project, job, await P.contract(root, project, basis.chapter, { outlineCache })), batchContract(project, job, basis.contract))) { valid = false; break }
    } catch { valid = false }
    if (valid) {
      const path = await safePath(root, `.novel-workshop/read-receipts/${job.id}.json`)
      const receipt = existsSync(path) ? await P.jsonFile(path) : null
      if (receipt?.task === job.id && receipt.agent === job.agent && receipt.scopeRevision === job.scopeRevision) {
        await writeFile(path, JSON.stringify({ ...receipt, scopeRevision: scope.revision }) + '\n', 'utf8')
      }
      job.scopeRevision = scope.revision
      if (wasPaused) job.status = 'running'
      if (job.batch) {
        job.deferredChapters = [...(job.deferredChapters ?? []), ...job.chapters.filter(id => !job.committed.some(row => row.chapter === id) && !W.inScope(project, id))]
        job.chapters = job.chapters.filter(id => job.committed.some(row => row.chapter === id) || W.inScope(project, id))
        job.basis = job.basis.filter(row => job.chapters.includes(row.chapter))
        await prepareTask(root, project, job)
      }
      job.reason = wasPaused ? '恢复授权覆盖本单且原复核通过重新预检，直接收件' : '授权范围未扩大，本单章号、权限及制作依据仍有效，保留原代理与结果继续收件'
      kept.push(job.id)
    } else {
      job.status = 'cancelled'; job.reason = '授权或任务依据已变化，保留产物后按新范围重新派单'; cancelled.push(job.id)
    }
  }
  return { kept, cancelled, ...(paused.length ? { paused } : {}) }
}

export async function requiredInputs(root, job) {
  const directory = await safePath(root, job.currentDirectory ?? job.directory), files = new Map()
  const add = (path, lines = null) => { if (!files.has(path)) files.set(path, { path, lines }) }
  add(resolve(directory, 'prompt.md')); add(resolve(directory, 'context.json')); add(resolve(core, 'roles', `${job.role}.md`))
  async function packet(path) {
    const context = await P.jsonFile(await safePath(root, path))
    for (const item of context.textFiles ?? []) add(await safePath(root, item.path), item.lines)
    if (context.reviewReadings?.length) {
      if (context.sharedReviewReading) add(await safePath(root, context.sharedReviewReading.path), context.sharedReviewReading.lines)
      for (const item of context.reviewReadings) add(await safePath(root, item.path), item.lines)
      return
    }
    for (const item of context.sharedReadings ?? []) add(await safePath(root, item.path), item.lines)
    if (context.manuscript?.path) add(await safePath(root, context.manuscript.path), context.manuscript.lines)
    for (const item of context.manuscripts ?? []) add(await safePath(root, item.path), item.lines)
    for (const item of context.packets ?? []) { add(await safePath(root, item.path)); await packet(item.path) }
  }
  await packet(resolve(directory, 'context.json'))
  return [...files.values()]
}
export async function dispatch(root, project, data, { replaces, replacementReason } = {}) {
  if (!roles[data.role]?.includes(data.action)) throw new Error('任务需要明确六岗位 role 与该岗位支持的 action')
  if (data.review !== undefined && data.action !== 'calibrate') throw new Error('review仅供calibrate填写已登记的审阅ID，不接收额外提示词；复核格式按context.resultContract，不把提示词传进review')
  if (project.scope.mode === 'pause') throw new Error('当前已暂停，不派发新制作任务')
  if (P.missingParameters(project).length) throw new Error('先处理 configure：查明并确认首次运行缺失参数')
  let chapters = []
  if (data.chapter !== undefined) chapters = [P.integer(data.chapter)]
  else if (data.chapters) chapters = [...new Set(data.chapters.map(n => P.integer(n)))].sort((a, b) => a - b)
  else if (data.from !== undefined || data.to !== undefined) {
    const from = P.integer(data.from ?? project.scope.from), to = P.integer(data.to ?? project.scope.to)
    if (to < from) throw new Error('任务结束章号小于起始章号')
    chapters = Array.from({ length: to - from + 1 }, (_, i) => from + i)
  }
  if (data.action === 'final-review') chapters = Array.from({ length: project.end - project.start + 1 }, (_, i) => project.start + i)
  if (chapters.some(id => data.action === 'final-review' ? id < project.start || id > project.end : !W.inScope(project, id))) throw new Error('任务超出当前授权范围')
  if (['文笔', '复核'].includes(data.role) && !chapters.length) throw new Error('文笔与复核任务需要章号或范围')
  if (data.action === 'outline' && chapters.length !== 1) throw new Error('细纲任务需要一个明确的 --chapter')
  let calibration = null
  if (data.action === 'calibrate') {
    const target = calibration = P.calibrationTarget(project, (await W.approvals(root, project)).approved)
    if (!target || data.review && data.review !== target.review) throw new Error('没有匹配当前授权的待校准批次')
    if (!chapters.length) chapters = Array.from({ length: target.to - target.from + 1 }, (_, i) => target.from + i)
    if (chapters[0] !== target.from || chapters.at(-1) !== target.to || chapters.length !== target.to - target.from + 1) throw new Error('校准任务必须覆盖当前待校准范围')
  }
  if (data.role === '文笔' && !['write', 'finish'].includes(data.action) && chapters.length !== 1) throw new Error('返修任务只处理一章')
  const batch = data.action === 'write' && chapters.length > 1
  if (batch && (chapters.length > 3 || chapters.some((id, index) => id !== chapters[0] + index || P.latest(project, id)) ||
      chapters.at(-1) >= project.scope.from + (Math.floor((chapters[0] - project.scope.from) / project.interval) + 1) * project.interval)) throw new Error('小批次写作限连续2—3个未写章，不能跨越复审节点')
  if (batch) for (const chapter of chapters) if (!(await P.outlineContext(root, project, chapter)).outline.text?.trim()) throw new Error('批次内细纲缺失，先补规划或回退单章')
  const triage = P.pendingTriage(project)
  if (triage && data.role === '文笔') throw new Error(`先处理队长分流 triage：${triage.id}，不能提前派返修单`)

  if (data.role === '文笔' && !['continue', 'revise'].includes(project.scope.mode)) throw new Error('当前授权不允许文笔制作')
  const report = data.role === '文笔' ? await W.assertWriteReady(root, project, chapters[0]) : undefined
  if (data.action === 'finish') for (const chapter of chapters) {
    if (!P.latest(project, chapter)) throw new Error(`第${P.pad(chapter)}章尚无当前稿，finish只能补已有稿的记录`)
    await W.assertWriteReady(root, project, chapter, report)
  }
  if (data.role === '文笔' && ['repair', 'repair-length', 'repair-format'].includes(data.action) && W.openIssues(project, chapters[0]).some(P.issueBlocks) &&
    report.tasks.some(task => task.type === 'review' && task.chapters.includes(chapters[0])) &&
    !report.tasks.some(task => ['repair', 'repair-length', 'repair-format'].includes(task.type) && task.chapters.includes(chapters[0]))) throw new Error('当前返修已提交，先派独立复核确认旧问题，不能重复返修待验稿')
  const active = project.jobs.filter(x => x !== replaces && ['pending', 'running'].includes(x.status) && x.scopeRevision === project.scope.revision)
  const duplicate = active.find(x => x.role === data.role && x.action === data.action && (x.microfix ?? null) === (data.microfix ?? null) && equal(x.chapters, chapters))
  if (duplicate) {
    if (replaces) throw new Error(`同范围已有任务 ${duplicate.id}，先核对执行状态`)
    return taskInfo(root, duplicate)
  }
  if (data.role === '文笔' && active.some(x => x.role === '文笔')) throw new Error('已有文笔任务，先收集实际结果再制作后章')
  const id = `job-${String(project.jobs.length + 1).padStart(4, '0')}`, directory = `.novel-workshop/tasks/${id}`
  const job = { id, directory, role: data.role, action: data.action, chapters, scopeRevision: project.scope.revision,
    status: 'pending', agent: null, ...(data.microfix ? { microfix: data.microfix } : {}), ...(data.issueIds ? { triageIssues: data.issueIds } : {}), ...(batch ? { batch: true, cursor: 0, committed: [] } : {}), batchKey: batchKey(project, chapters[0] ?? project.scope.from), time: new Date().toISOString(), review: data.review ?? null, basis: [] }
  const outlineCache = new Map()
  for (const chapter of chapters) job.basis.push({ chapter, version: P.latest(project, chapter)?.version ?? null, contract: await P.contract(root, project, chapter, { outlineCache }) })
  await prepareTask(root, project, job, { report, calibration })
  if (replaces) Object.assign(replaces, { status: 'cancelled', replacedBy: id, updated: job.time, reason: replacementReason })
  project.jobs.push(job)
  await P.save(root, project)
  return taskInfo(root, job)
}

export async function requeueInterrupted(root, project, id) {
  const job = project.jobs.find(row => row.id === id)
  if (!job || !nativeRuntimes.includes(job.runtime) || project.scope.mode === 'pause' || job.scopeRevision !== project.scope.revision) {
    throw new Error('重派需要当前授权下已绑定的原生子代理任务')
  }
  if (job.replacedBy) {
    const replacement = project.jobs.find(row => row.id === job.replacedBy)
    if (replacement?.status === 'pending' && replacement.scopeRevision === project.scope.revision) return taskInfo(root, replacement)
    throw new Error(`旧单已重派为 ${job.replacedBy}，请核对新单状态`)
  }
  if (job.status !== 'running') throw new Error('只有已绑定的运行中任务可以按中断重派，待启动单可直接绑定')
  const { next, resultIssue } = await taskContinuation(root, job)
  if (next === 'result-unreadable') throw new Error(`本单结果暂无法读取，先核对文件访问：${resultIssue}`)
  if (next !== 'check-worker' && next !== 'invalid-result') throw new Error('本单已有结果或已全部提交，先核验并收件或逐章提交')
  const replacementReason = next === 'invalid-result'
    ? '原执行者已停止，结果 JSON 损坏，保留原单文件并按当前依据重派'
    : '原执行者已停止且未交结果，按当前依据重派'
  const chapters = job.chapters.filter(chapter => !job.committed?.some(row => row.chapter === chapter))
  return await dispatch(root, project, { role: job.role, action: job.action, chapters, review: job.review ?? undefined,
    microfix: job.microfix, issueIds: job.triageIssues }, { replaces: job, replacementReason })
}
export async function prepareTask(root, project, job, { report, calibration } = {}) {
  const data = job, chapters = job.batch ? [currentChapter(job)] : job.chapters, id = job.id
  const directory = job.batch ? `${job.directory}/segments/${P.pad(chapters[0])}` : job.directory
  job.currentDirectory = directory
  const outlineCache = new Map()
  const full = await safePath(root, directory)
  await mkdir(full, { recursive: true })
  const shared = await sharedMaterials(root, project, chapters[0] ?? project.scope.from)
  let context
  if (data.action === 'finish') {
    const manuscripts = []
    for (const chapter of chapters) {
      const row = project.chapters[chapter], version = P.latest(project, chapter)
      manuscripts.push({ chapter, ...await manuscriptView(root, project, chapter, full), length: P.lengthInfo(project, chapter, version.words),
        entryState: row.entryState ?? P.currentExitState(project, chapter - 1), entities: row.entities ?? [], factIds: row.factIds ?? [] })
    }
    context = { action: 'finish', scope: project.scope, manuscripts,
      instruction: '按章顺序完整读回manuscripts中的当前正文，从实际已发生内容提取notes、experience、exitState；入章登记只供定位，以正文为准。仅补记录，不复制、润色或改写正文，不重读底本/整册/旧任务结果，不增加通过判决。发现正文疑点记入notes交后续独立复核，不在finish提交补丁。' }
  } else if (data.role === '文笔' || data.action === 'outline') {
    context = await W.context(root, project, chapters[0], { report, outlineCache, diagnosis: false })
    if (data.role === '文笔' && data.action !== 'write') {
      if (!P.latest(project, chapters[0])) throw new Error('返修/补记录需要已有本章当前稿')
      context.manuscript = await manuscriptView(root, project, chapters[0], full)
      context.repair = { mode: 'patches', instruction: '直接读取manuscript当前稿，默认定点修补并保留其他场景与已修内容。首次独立重写禁止参考历史旧稿，不表示禁止返修本轮新稿；若作者明确连本轮当前稿也禁止读取，报告冲突。确需整章重写时提供rewriteReason。' }
    }
  }
  else if (data.role === '复核') {
    const draft = await W.reviewDraft(root, project, chapters, data.action === 'final-review' ? 'final' : 'batch', { outlineCache })
    const reviewData = { ...draft.data, chapters: draft.data.chapters.map(({ contract, stamp, ...row }) => row) }
    const packets = [], packetDir = await safePath(root, `${directory}/chapters`)
    await mkdir(packetDir, { recursive: true })
    const sourceLines = project.source && await P.optionalStamp(P.local(root, project.source.path)) ?
      (await P.textFile(P.local(root, project.source.path), project.source.encoding)).split(/\r?\n/) : null
    for (const chapter of chapters) {
      const path = await safePath(root, resolve(packetDir, `${P.pad(chapter)}.json`))
      const manuscript = await manuscriptView(root, project, chapter, packetDir)
      const packet = await W.context(root, project, chapter, { diagnosis: false, sourceLines, outlineCache })
      if (packet.previous && chapters.includes(chapter - 1)) packet.previous = { path: packet.previous.path, includedInReview: chapter - 1 }
      await writeContext(root, `${directory}/chapters/${P.pad(chapter)}-materials`, path, { ...packet, manuscript }, shared)
      packets.push({ chapter, path, manuscript: manuscript.path, originalPath: manuscript.originalPath })
    }
    const readings = await buildReviewReadings(root, directory, packets)
    const previous = project.reviews.findLast(review => review.kind === draft.data.kind && review.chapters.some(row => chapters.includes(row.chapter)))
    const unchangedInputs = previous ? draft.data.chapters.filter(row => {
      const old = previous.chapters.find(item => item.chapter === row.chapter)
      return old && old.version === row.version && old.path === row.path && P.sameStamp(old.stamp, row.stamp) && P.sameContract(old.contract, row.contract)
    }).map(row => row.chapter) : []
    context = { reviewDraft: { path: draft.path, data: reviewData }, packets, ...readings, scope: project.scope,
      resultContract: { verdict: ['passed', 'rework'], missingReceipt: '缺两更的章先按现稿做独立检查，判rework并在summary注明待补登记；实读无内容缺陷时issues可为空。', issue: { text: '规则、原文问题与修法（必填，不只写rule/fix分项）', from: chapters[0], to: chapters[0], severity: 'yellow',
        evidence: { path: '本章manuscript.originalPath', quote: '从该正式稿逐字复制的连续短句，不拼接或补引号' } },
        chapterEvidence: [{ path: '本条chapters[i].path（正式正文路径）', quote: '从当前稿逐字复制的连续短句' }],
        grades: { values: ['A', 'B', 'C', 'D'], example: { grade: 'B', reason: '实际阅读判断依据' }, passedRequires: '各维度A/B且reason非空，不写良好/合格；真正低于B时判返修，不为格式校验抬分' },
        correction: '保存result.json后先处理宿主预检反馈；仅字段或引文错误在原单修正，不重新冷读整批、不伪造通过。' },
      reviewFocus: { previousReview: previous?.id ?? null, previousReviewer: previous?.reviewerAgent ?? null,
        changedInputs: chapters.filter(chapter => !unchangedInputs.includes(chapter)), unchangedInputs,
        instruction: '本列表只比较版本、路径、时间与任务依据，不表示审阅通过；当前开放问题仍逐项判决。新代理读全；同一Codex复核代理仅可复用自己已读且未变的输入，当前改稿及影响的前后关系仍须回读。DSH复用本人真实读过且未变的共享输入；新代理或丢失上下文仍完整读取。' },
      instruction: '按requiredReads完整读取逐章reviewReadings和sharedReviewReading，已整合packets、textFiles和当前正文的完整内容，勿再逐份重复读同内容的JSON与TXT。结构化packets保留供定位。按offset/limit分页；证据使用manuscript.originalPath，不引用整合稿路径，不跨新增换行取句。DSH保存结果后由宿主自动预检，不运行CLI；Codex/ZCode按context.runtime.cli执行result-check只读预检，正式收件仍由队长collect。' }
  } else context = { diagnosis: await W.diagnose(root, project), scope: project.scope, chapters,
    parameters: { title: project.title, mode: project.mode, start: project.start, end: project.end,
      ...(project.length.type === 'fixed' ? { words: project.words } : {}), length: project.length, interval: project.interval },
    requirements: project.requirements.filter(item => item.status === 'active' && item.to >= project.scope.from && item.from <= project.scope.to),
    calibration,
    readingPaths: ['00-状态.md', '.novel-workshop/当前要求.md', project.paths.notes, project.paths.experience,
      ...project.materials.filter(x => x.status === 'active').map(x => x.path)].map(p => P.local(root, p)).filter(path => existsSync(path)) }
  if (D.rolePurposes[data.role]) {
    context.documents = await D.forRole(root, project, data.role)
    context.readingPaths = [...new Set([...(context.readingPaths ?? []), ...context.documents.targets.filter(item => item.exists).map(item => P.local(root, item.path))])]
    const targets = new Set([...context.documents.references.map(item => item.path), ...context.documents.targets.map(item => item.path).filter(Boolean)])
    job.documentBasis = []
    for (const target of targets) job.documentBasis.push({ path: target, stamp: await P.optionalStamp(P.local(root, target)) })
  }
  if (data.action === 'calibrate') job.review = context.calibration?.review ?? data.review
  const protocol = data.role === '文笔' ? (data.action === 'finish' ?
    `本单只补现稿记录。${chapters.length === 1 ? 'result.json 写 {"notes":"实际注意事项","experience":"实际经验","exitState":{...},"entities":[],"factIds":[]}。' : 'result.json 写 {"chapters":[{"chapter":章号,"notes":"实际注意事项","experience":"实际经验","exitState":{...},"entities":[],"factIds":[]}]}，覆盖本单每一章。'}只从当前正文提取；不要提交text、draftFile、patches或另抄草稿，程序明确拒绝正文改动。保存result.json后DSH自动反馈现稿精确字数，Codex可用draft-check；无须另写正文计量。独立复核在补登记后另派。` :
    `${context.repair ? 'result.json用patches提交定点修订；只有确需整章重写时才用text并附rewriteReason。' : 'result.json用text提交完整Markdown正文，含章标题。'}同时填写title、notes、experience、exitState及必要entities/factIds。`) :
    data.role === '复核' ? '使用reviewDraft.data作为结果模板，完整读取逐章整合阅读稿及共享依据，不再重复读取同内容的旧格式材料；无需抄写contract或stamp，宿主按派单依据补齐并核实。整单与每个chapters条目的verdict均为passed/rework；有问题的章返修，其他完成全部检查且无阻塞的章明确passed，程序保留未受影响的逐章通过；旧问题在resolutions逐项填open/resolved，resolved须给resolution及当前稿evidence。issues只新增新发现，跨章问题用affectedChapters列齐需要修改正文或出章状态的章，from/to覆盖其完整范围；只作背景引用的章不算待修范围。red必阻塞、yellow默认阻塞；可选建议用info或blocking:false说明理由。不得修改正文或主账。' :
    data.action === 'calibrate' ? '实际核对或更新当前待校准范围内细纲，把 {"outline":[已核对章号],"note":"复盘及调整依据","artifacts":[{"path":"任务目录内文件","target":"项目细纲相对路径"}]} 写入 result.json。' :
    '先分析context.documents的已有文档、候选与实际相关段落；已有成果可用时artifacts为空，不另建一份。需要补充时优先artifacts:[{target:"已有文档相对路径",patches:[{before:"唯一原句",after:"修改后原句"}]}]，或path指定任务内完整文件。新建同用途文件须createReason解释已有文件为何不能承载。result.json同时提供summary；来源与批准由队长登记。'
  if (job.microfix) {
    const fix = project.microfixes?.find(row => row.id === job.microfix && row.status === 'pending-confirmation')
    if (job.role !== '复核' || !fix || chapters.length !== 1 || chapters[0] !== fix.chapter || P.latest(project, fix.chapter)?.version !== fix.afterVersion) throw new Error('微修确认必须对应待确认的新版本及完整单章')
    context.microfix = { ...fix, instruction: '本单独立确认程序微修；原复核的全文阅读上下文仍有效时可由宿主切换定点差异材料。未确认保留阻塞，不自行将新稿当通过。' }
  }
  context.runtime = runtime
  if (job.batch) context.batch = { task: job.id, current: currentChapter(job), planned: job.chapters, committed: job.committed.map(row => row.chapter),
    instruction: '每次只制作current章。保存当前resultPath后用novel_submit（Codex用chapter-commit --task ID --file 当前结果）逐章提交；程序校验并保存正文、两更和出章状态后返回下一章的新prompt/context/result路径。必须读取新材料后再写下一章，不把多章塞进最终JSON。上下文不足可stopAfter/--stop-after，在章边界结束本单；前章进度保留。' }
  if (context.readingPaths?.length) {
    context.sharedReadings = []
    for (const originalPath of [...new Set(context.readingPaths)]) if (existsSync(originalPath)) {
      const source = await P.textFile(originalPath)
      const journal = [project.paths.notes, project.paths.experience].some(path => P.local(root, path) === originalPath)
        ? P.journalSlice(source, project, currentChapter(job) ?? project.scope.from, (context.outline?.ranges ?? []).map(range => range.chapter)) : null
      const text = readingText(journal?.text ?? source)
      let file = shared.files.get(text)
      if (!file) {
        const path = await safePath(root, resolve(shared.directory, `text-${shared.files.size + 1}.txt`))
        await writeFile(path, text, 'utf8')
        file = { path, lines: text.split('\n').length - Number(text.endsWith('\n')), wrapped: true }
        shared.files.set(text, file)
      }
      context.sharedReadings.push({ originalPath, ...file, ...(journal?.omittedSections ? { scoped: true, sourceRanges: journal.ranges, omittedSections: journal.omittedSections } : {}) })
    }
    context.readingPaths = context.sharedReadings.map(item => item.path)
  }
  await writeContext(root, directory, resolve(full, 'context.json'), context, shared)
  const inputs = await requiredInputs(root, job)
  const storedContext = await P.jsonFile(resolve(full, 'context.json'))
  await writeFile(resolve(full, 'context.json'), JSON.stringify({ requiredReads: inputs, ...storedContext }, null, 2) + '\n', 'utf8')
  const repairProtocol = data.role === '文笔' && context.repair && data.action !== 'finish' ? '\n返修result.json优先用patches:[{before:"当前稿唯一原句",after:"修改后原句"}]替代text，仍提交notes/experience/exitState；不涉及的正文由程序原样保留。' : ''
  const measureProtocol = data.role === '文笔' && data.action !== 'finish' ? '\n先在当前任务内分配各场景的内容与篇幅，再连续写成完整初稿；不要先写半章再逐句补到某个比例。自查发现的同轮修改集中完成；完整稿保存一次后按宿主计量处理实际缺口，不在每改一句后计量，也不为减少调用跳过必要修订。DSH保存result.json自动反馈；单独草稿可用novel_draft，Codex/ZCode用draft-check，完整修订后再核对。minRatio/maxRatio为空时没有95%等数字门槛，不从历史比例推导合格线；按本章场景份量完整起草，只有具体内容缺口才集中补齐。已有唯一完整草稿可用draftFile替代text；排版只用format的heading/indent机械处理，不重抄整章。字数相同不证明内容相同，返修看comparison，不写计数探针。' : ''
  await writeFile(await safePath(root, resolve(full, 'prompt.md')), `# ${id} · ${data.role} · ${data.action}\n\n项目：${root}\n章号：${chapters.join('、') || '当前授权范围'}\n\n你是独立的${data.role}子代理，不是主会话队长。实际CLI、手册与协议路径见context.runtime，不猜测项目内bin/core。先读岗位卡 ${resolve(core, 'roles', `${data.role}.md`)} 和本目录 context.json，按其中真实文件取证。\n仅在本任务目录 ${full} 内写文件；不得直接写项目登记、正式章稿、两更或别的任务目录。单章结果由队长collect提交；小批次仅用专用chapter-commit/novel_submit逐章提交，结束后由队长收件。不创建其他聊天，不转派本岗位工作。\nCodex/ZCode首次启动尚未绑定时只读准备，收到队长对本单的绑定成功确认后才执行并写结果；同岗位续单先绑定再通知，不自行轮询主账。DSH派单已由宿主预先绑定，可按启动通知直接执行。\n${data.action === 'finish' ? '本单不创作或修订正文，只提取当前稿的两更与出章状态；岗位卡中的首稿、返修和草稿交稿流程不适用于本单。' : data.role === '文笔' ? '只有你负责正文创作。' : '你不得创作或改写小说正文。'}\n\n${protocol}${repairProtocol}${measureProtocol}\n\n## 完整必读清单\n\n${inputs.map(item => `- ${item.path}${item.lines ? `（约${item.lines}行）` : ''}`).join('\n')}\n\n按清单逐份read，独立文件可在同一步并行读取；分页读到末尾。材料齐全后直接完成岗位工作，不额外读插件源码、整册或整份project.json查协议。\n\n完成后返回 result.json 绝对路径及≤200字结果摘要；没有材料或权限时明确报告阻塞，不伪造完成。\n`, 'utf8')
}
export async function updateTask(root, project, data) {
  const job = project.jobs.find(x => x.id === data.id)
  if (!job) throw new Error('任务单不存在')
  if (data.status === 'running') {
    if (!['pending', 'running'].includes(job.status) || job.scopeRevision !== project.scope.revision) throw new Error('任务已终止或授权已变化，请重新派单')
    if (typeof data.agent !== 'string' || !data.agent.trim()) throw new Error('启动任务需要原生子代理的实际 agent ID')
    if (data.runtime !== undefined && !nativeRuntimes.includes(data.runtime)) throw new Error(`不支持的运行时标识：${data.runtime}（只支持 ${nativeRuntimes.join(' / ')}）`)
    if (job.agent && job.agent !== data.agent) throw new Error('不可替换运行中任务的子代理，先取消旧单再派新单')
    if (project.jobs.some(other => other.id !== job.id && other.agent === data.agent && other.role !== job.role)) throw new Error('六岗位使用独立子代理，不能复用其他岗位的执行者')
    if (project.jobs.some(other => other.id !== job.id && other.agent === data.agent && ['pending', 'running'].includes(other.status))) throw new Error('该子代理已有未收件任务，先collect或取消旧单，再绑定新单；不能同时执行两张任务单')
    if (job.role === '复核' && job.chapters.some(n => P.latest(project, n)?.authorAgent === data.agent)) throw new Error('复核子代理不能与本章文笔子代理相同')
    job.agent = data.agent
    job.runtime ??= data.runtime ?? 'codex-native-v1'
  } else if (!['failed', 'cancelled'].includes(data.status) || !data.reason?.trim() || job.status === 'completed') throw new Error('任务状态支持 running、failed、cancelled；失败或取消需 reason')
  job.status = data.status; job.reason = data.reason ?? null; job.updated = new Date().toISOString()
  await P.save(root, project)
  return taskInfo(root, job)
}
async function prepareArtifacts(root, project, job, data) {
  const plans = { 主编: ['01-设想.md', '03-大纲.md', '04-文风.md', '05-总纲要.md'], 世界: ['01-世界.md', '02-世界/', '05-总纲要.md'],
    人物: ['02-人设/', '02-人物档案.md'], 剧情: ['03-大纲.md', '05-总纲要.md', `${project.paths.outline}/`] }
  const pending = []
  if (data.artifacts !== undefined && !Array.isArray(data.artifacts)) throw new Error('artifacts 必须是数组')
  const taskRoot = await safePath(root, job.directory), destinations = new Set()
  const outlines = await Promise.all(job.chapters.map(id => P.existingOutline(root, project, id)))
  const documents = await D.forRole(root, project, job.role)
  for (const item of data.artifacts ?? []) {
    if (typeof item.target !== 'string' || (typeof item.path !== 'string' && !Array.isArray(item.patches))) throw new Error('任务 artifacts 需要target及path或patches')
    const from = item.path === undefined ? null : await safePath(taskRoot, within(taskRoot, item.path))
    const to = await safePath(root, within(root, item.target)), name = P.portable(root, to)
    if (/^AGENTS(?:\.override)?\.md$/i.test(basename(to))) throw new Error('岗位产物不能修改宿主指令文件')
    if (['body', 'reports', 'output'].some(kind => inside(P.local(root, project.paths[kind]), to)) || inside(P.local(root, '.novel-workshop'), to) || name === '00-状态.md') throw new Error('策划产物不能写入正式正文、验收、成书或工坊状态')
    if (['calibrate', 'outline'].includes(job.action) && !outlines.includes(to)) throw new Error('本次动作只能提交任务单指定的细纲文件')
    const key = process.platform === 'win32' ? to.toLowerCase() : to
    if (destinations.has(key)) throw new Error('任务产物目标不能重复')
    destinations.add(key)
    const reusable = documents.references.some(doc => doc.path === name && doc.kinds.some(kind => D.rolePurposes[job.role]?.includes(kind)))
    const chapterOutput = job.role === '剧情' && ['outline', 'calibrate'].includes(job.action) && outlines.includes(to)
    if (!(plans[job.role] ?? []).some(prefix => prefix.endsWith('/') ? name.startsWith(prefix) : name === prefix) && !reusable && !chapterOutput || !/\.(md|txt)$/i.test(name)) throw new Error(`岗位无权提交该正式文件：${name}`)
    if (job.role === '剧情' && name.startsWith(project.paths.outline + '/')) {
      const match = name.match(/第(\d+)章\.md$/)
      if (!match || !W.inScope(project, Number(match[1])) || job.chapters.length && !job.chapters.includes(Number(match[1]))) throw new Error('细纲结果超出任务授权范围')
    }
    const current = existsSync(to) ? await readFile(to) : null
    const basis = job.documentBasis?.find(item => P.local(root, item.path) === to)
    if (basis && !P.sameStamp(basis.stamp, await P.optionalStamp(to))) throw new Error('已有文档在派单后发生变化，请重读并重新派单，避免覆盖作者更新')
    if (!current && !['outline', 'calibrate'].includes(job.action)) {
      const kind = documents.targets.find(target => target.path === name)?.kind ?? D.rolePurposes[job.role]?.find(kind => D.purposes[kind].path === name) ?? (D.rolePurposes[job.role]?.length === 1 ? D.rolePurposes[job.role][0] :
        name.startsWith('02-世界/') ? 'world' : null)
      const candidates = kind ? documents.targets.find(target => target.kind === kind)?.candidates ?? [] : []
      if (candidates.length && !item.createReason?.trim()) throw new Error(`已有同用途文档：${candidates.join('、')}；优先更新原文件，确需独立新文件时说明createReason`)
    }
    let content
    if (item.patches !== undefined) {
      if (!current || item.path !== undefined || !item.patches.length) throw new Error('文档patches需要已有目标，且不能同时提交path')
      let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(current)
      for (const patch of item.patches) {
        if (typeof patch.before !== 'string' || !patch.before || typeof patch.after !== 'string') throw new Error('文档patches需要非空before与字符串after')
        const at = text.indexOf(patch.before)
        if (at < 0 || text.indexOf(patch.before, at + 1) >= 0) throw new Error('文档补丁before必须唯一匹配已有原句')
        text = text.slice(0, at) + patch.after + text.slice(at + patch.before.length)
      }
      content = Buffer.from(text, 'utf8')
    } else content = await readFile(from)
    new TextDecoder('utf-8', { fatal: true }).decode(content)
    if (!current?.equals(content)) pending.push({ to, content })
  }
  return pending
}
async function commitArtifacts(root, pending) {
  for (const item of pending) {
    await safePath(root, item.to)
    await mkdir(dirname(item.to), { recursive: true })
    await writeFile(item.to, item.content)
  }
  return pending.map(x => x.to)
}
export async function assertReadReceipt(root, job) {
  if (job.runtime === 'dsh-worker-v1') {
    const receipt = await P.jsonFile(await safePath(root, `.novel-workshop/read-receipts/${job.id}.json`)).catch(() => null)
    if (receipt?.complete !== true || receipt.task !== job.id || receipt.agent !== job.agent || receipt.scopeRevision !== job.scopeRevision || job.batch && receipt.chapter !== currentChapter(job)) throw new Error('缺少真实worker完整阅读回执，不能收件；等待完成通知，缺料则记录失败后重新派发')
    return receipt
  }
}
function batchContract(project, job, contract) {
  if (!job.batch) return contract
  return { ...contract, linkedChapters: contract.linkedChapters.map(row =>
    job.committed.some(item => item.chapter === row.chapter) && P.latest(project, row.chapter)?.task === job.id ? { chapter: row.chapter, committedByTask: job.id } : row) }
}
export async function assertTaskBasis(root, project, job) {
  const outlineCache = new Map()
  if (job.batch) for (const item of job.committed) if (!await P.versionValid(root, project.chapters[item.chapter].versions.find(row => row.version === item.version))) throw new Error('已提交前章实际文件已变化，先核对登记，不继续后章')
  for (const basis of job.basis) {
    if (job.role === '文笔' && P.latest(project, basis.chapter)?.task === job.id || job.role === '复核' && project.reviews.some(x => x.task === job.id)) continue
    if ((P.latest(project, basis.chapter)?.version ?? null) !== basis.version || !P.sameContract(batchContract(project, job, await P.contract(root, project, basis.chapter, { outlineCache })), batchContract(project, job, basis.contract))) throw new Error('任务材料已变化，取消旧单并重新派发受影响岗位')
    if (job.role === '复核' && !await P.versionValid(root, P.latest(project, basis.chapter))) throw new Error('任务材料已变化，当前稿登记失效，先核对版本，不能仅修结果字段')
  }
}
function reviewData(project, job, data) {
  return { ...data, chapters: data.chapters?.map(row => ({ ...row,
    stamp: row.stamp ?? P.latest(project, row.chapter)?.stamp,
    contract: row.contract ?? job.basis.find(item => item.chapter === row.chapter)?.contract })) }
}
export async function inspectResult(root, project, id) {
  const job = requireJob(project, id, '复核', undefined, ['review', 'final-review'])
  await assertReadReceipt(root, job)
  await assertTaskBasis(root, project, job)
  const old = project.reviews.find(review => review.task === job.id)
  if (old) return { valid: true, existingReview: old.id, verdict: old.verdict }
  const data = await P.jsonFile(await safePath(root, `${job.directory}/result.json`))
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.chapters)) throw new Error('复核结果需要JSON对象及chapters数组；按context.reviewDraft.data修正原文件')
  return W.submitReview(root, project, reviewData(project, job, data), job.id, { checkOnly: true })
}
export async function collect(root, project, id) {
  const job = project.jobs.find(x => x.id === id)
  if (job?.status === 'completed') return { ...taskInfo(root, job), output: job.output }
  requireJob(project, id, job?.role)
  if (job.batch) {
    await assertTaskBasis(root, project, job)
    if (job.committed.length !== job.chapters.length) throw new Error('小批次尚有未提交章，使用chapter-commit逐章落盘；不得最终一次性交多章JSON')
    job.status = 'completed'; job.output = { committedChapters: job.committed, registeredChapters: job.committed.map(row => row.chapter) }; job.updated = new Date().toISOString()
    await P.save(root, project)
    return { ...taskInfo(root, job), output: job.output }
  }
  await assertReadReceipt(root, job)
  const data = await P.jsonFile(await safePath(root, `${job.directory}/result.json`))
  const chapter = job.chapters[0]
  await assertTaskBasis(root, project, job)
  let output
  if (job.role === '文笔') {
    if (job.action === 'finish') {
      const rows = finishRows(job, data)
      const report = await W.assertWriteReady(root, project, rows[0].chapter)
      // 先验证整单，避免最后一章缺项或失效时前章已写入两更。
      for (const row of rows) {
        if (!await P.versionValid(root, P.latest(project, row.chapter))) throw new Error('补登记的当前章稿已变化，先核对版本')
        await W.assertWriteReady(root, project, row.chapter, report)
      }
      const receipts = []
      for (const row of rows) receipts.push({ chapter: row.chapter, receipt: await W.finish(root, project, row, job.id, report) })
      output = { receipts }
    } else {
      W.validateReceipt(data)
      const current = P.latest(project, chapter)
      if (current?.task !== job.id) output = await W.writeChapter(root, project, chapter, await writerText(root, project, job, data), false, job.id)
      else output = { path: P.local(root, current.path), version: current.version }
      const receipt = await W.finish(root, project, { ...data, chapter }, job.id)
      output = { ...output, receipt }
    }
  } else if (job.role === '复核') {
    const old = project.reviews.find(x => x.task === job.id)
    const restored = reviewData(project, job, data)
    output = old ? { review: old } : await W.submitReview(root, project, restored, job.id)
  } else {
    if (job.action !== 'calibrate' && !data.summary?.trim()) throw new Error('岗位结果需要 summary')
    if (job.action === 'calibrate' && Object.hasOwn(data, 'chapters')) throw new Error('批次校准任务不能提交作者熔断恢复 chapters')
    const pending = await prepareArtifacts(root, project, job, data)
    let calibration
    if (job.action === 'calibrate') {
      if (!equal([...new Set(data.outline ?? [])].sort((a, b) => a - b), job.chapters)) throw new Error('校准结果章号必须与任务单一致')
      calibration = await P.prepareCalibration(root, project, { outline: data.outline, note: data.note, review: job.review,
        source: { task: job.id, agent: job.agent } }, pending.map(item => item.to), (await W.approvals(root, project)).approved)
    }
    output = { summary: data.summary ?? data.note, files: await commitArtifacts(root, pending) }
    if (calibration) { project.calibrations.push(calibration); output.calibration = calibration }
  }
  if (job.triageIssues) for (const id of job.triageIssues) {
    const issue = project.issues.find(row => row.id === id)
    if (issue?.triage?.route === 'plan') issue.triage = { ...issue.triage, route: 'repair', planningTask: job.id }
  }
  job.status = 'completed'; job.output = output; job.updated = new Date().toISOString()
  if (job.resultCorrection) job.resultCorrection.pending = false
  await P.save(root, project)
  return { ...taskInfo(root, job), output }
}

export async function commitChapter(root, project, data) {
  const job = project.jobs.find(item => item.id === data.task)
  const file = resolve(data.file ?? '')
  const previous = job?.committed?.find(item => item.resultPath === file)
  if (previous) return { committed: previous, repeated: true, task: taskInfo(root, job) }
  requireJob(project, data.task, '文笔', undefined, ['write'])
  if (!job.batch || job.committed.length === job.chapters.length) throw new Error('chapter-commit只用于仍有当前章的小批次写作任务')
  const info = taskInfo(root, job), chapter = currentChapter(job)
  if (file !== resolve(info.resultPath)) throw new Error('只能提交当前章resultPath，不能提前提交后章或引用别单')
  await assertReadReceipt(root, job)
  await assertTaskBasis(root, project, job)
  const result = await P.jsonFile(await safePath(root, file))
  W.validateReceipt(result)
  if (P.latest(project, chapter)?.task !== job.id) await W.writeChapter(root, project, chapter, await writerText(root, project, job, result), false, job.id)
  await W.finish(root, project, { ...result, chapter }, job.id)
  const current = P.latest(project, chapter)
  const committed = { chapter, version: current.version, path: current.path, words: current.words, resultPath: file }
  job.committed.push(committed); job.cursor++
  if (data.stopAfter === true) { job.deferredChapters = job.chapters.slice(job.cursor); job.chapters = job.chapters.slice(0, job.cursor) }
  if (job.cursor < job.chapters.length) {
    try {
      await assertTaskBasis(root, project, job)
      const basis = job.basis.find(row => row.chapter === currentChapter(job))
      basis.contract = await P.contract(root, project, currentChapter(job))
      await prepareTask(root, project, job)
    } catch (error) {
      job.status = 'failed'; job.reason = `前章已保存，后章材料准备失败：${error.message}`
      await P.save(root, project)
      return { committed, blocked: true, error: job.reason, task: taskInfo(root, job) }
    }
  }
  await P.save(root, project)
  return { committed, awaitingCollect: job.cursor === job.chapters.length, task: taskInfo(root, job),
    instruction: job.cursor < job.chapters.length ? '当前章已校验落盘；读取task的新promptPath/contextPath，再制作下一章。' : '本单各章已保存；返回任务摘要，由队长收件并续作。' }
}

export async function useMicroDelta(root, project, job, { contextRetained = false } = {}) {
  if (!contextRetained || !job.microfix) return false
  const fix = project.microfixes.find(row => row.id === job.microfix)
  const source = project.jobs.find(row => row.id === fix?.sourceTask)
  if (!fix || job.agent !== fix.reviewerAgent || source?.agent !== job.agent || source.status !== 'completed' || source.scopeRevision !== job.scopeRevision ||
      !P.sameContract(fix.beforeContract, await P.contract(root, project, fix.chapter))) return false
  const audit = await P.jsonFile(await safePath(root, fix.diffPath))
  const before = await P.textFile(P.local(root, fix.beforePath)), after = await P.textFile(P.local(root, fix.afterPath))
  if (audit.before !== before || audit.after !== after) return false
  let declared = before
  for (const patch of fix.patches) {
    const at = declared.indexOf(patch.before)
    if (at < 0 || declared.indexOf(patch.before, at + 1) >= 0) return false
    declared = declared.slice(0, at) + patch.after + declared.slice(at + patch.before.length)
  }
  if (fix.format) declared = formatManuscript(declared, fix.format)
  if (declared !== after) return false
  const path = await safePath(root, `.novel-workshop/microfixes/${fix.id}/confirmation.md`)
  const contexts = fix.patches.map(patch => {
    const at = after.indexOf(patch.after)
    return `问题${patch.issue}\n原句：${patch.before}\n替换：${patch.after}\n相关当前上下文：${after.slice(Math.max(0, at - 350), at + patch.after.length + 350)}`
  })
  const text = readingText(`# 微修定点确认 ${fix.id}\n原独立复核：${fix.sourceReview}；你本人${fix.reviewerAgent}已完整读过原稿及依据。\n当前正式稿：${P.local(root, fix.afterPath)}\n完整差异：${JSON.stringify(fix.patches)}\n机械排版：${JSON.stringify(fix.format ?? null)}\n程序已核对差异完整且依据未变。逐项复验问题、替换结果及前后指代；发现影响扩大就报告，不抬分或自动通过。必要时按正式路径回查。\n\n${contexts.join('\n\n')}`)
  await writeFile(path, text, 'utf8')
  const info = taskInfo(root, job), context = await P.jsonFile(info.contextPath)
  context.reviewReadings = [{ chapter: fix.chapter, path, lines: text.split('\n').length - Number(text.endsWith('\n')) }]
  delete context.sharedReviewReading
  context.textFiles = []; context.sharedReadings = []
  context.microfix.deltaOnly = true
  context.reviewFocus.instruction = '已验证原代理、原完整阅读及未变依据；本次按完整差异和相关上下文确认。上下文丢失或材料变化立即恢复完整读取。'
  await writeFile(info.contextPath, JSON.stringify(context, null, 2) + '\n', 'utf8')
  context.requiredReads = await requiredInputs(root, job)
  await writeFile(info.contextPath, JSON.stringify(context, null, 2) + '\n', 'utf8')
  await writeFile(info.promptPath, `# ${job.id} · 原复核定点确认\n\n你仍是原独立复核代理，只处理${fix.id}，不改正文。先读context.json、原岗位卡及requiredReads中的完整差异和上下文；原全文阅读与规则未变且仍在本人上下文。若已丢失则请求恢复完整材料，不凭摘要签认。使用reviewDraft.data提交逐章判决与resolutions，证据指向当前正式稿，写本任务result.json。\n`, 'utf8')
  job.deltaReview = true
  await P.save(root, project)
  return true
}
export function publicTask(job) {
  if (!job?.id?.startsWith('job-')) return job
  const keys = ['id', 'role', 'action', 'chapters', 'currentChapter', 'scopeRevision', 'status', 'agent', 'runtime', 'directory', 'promptPath', 'contextPath', 'resultPath', 'batch', 'cursor', 'committed', 'microfix', 'deltaReview', 'archive', 'archivedIn', 'reason', 'replacedBy']
  const result = Object.fromEntries(keys.filter(key => job[key] !== undefined).map(key => [key, job[key]]))
  if (job.output) {
    const { path, version, length, review, receipts, committedChapters, registeredChapters } = job.output
    result.output = { path, version, length, ...(receipts ? { registeredChapters: receipts.map(row => row.chapter) } : {}),
      ...(registeredChapters ? { registeredChapters } : {}), ...(committedChapters ? { committedChapters } : {}),
      ...(review ? { review: { id: review.id, verdict: review.verdict, summary: review.summary, triage: review.triage,
        chapters: review.chapters.map(row => ({ chapter: row.chapter, version: row.version, verdict: P.rowVerdict(review, row) })),
        issues: review.issues.length, resolved: review.resolutions?.filter(row => row.status === 'resolved').map(row => row.id) ?? [] } } : {}) }
  }
  return result
}
