import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as P from './project.mjs'
import * as W from './production.mjs'
import { safePath, inside } from './paths.mjs'
import * as D from './documents.mjs'

const roles = {
  主编: ['plan', 'capture-requirements', 'decision'], 世界: ['plan', 'facts'], 人物: ['plan', 'facts'],
  剧情: ['plan', 'outline', 'map-source', 'calibrate'],
  文笔: ['write', 'repair', 'repair-length', 'repair-format', 'finish'], 复核: ['review', 'final-review']
}
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'core')
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function readingText(text) {
  let output = '', column = 0
  for (const char of text.replace(/\r\n/g, '\n')) {
    if (char === '\n') column = 0
    else { if (column === 800) { output += '\n'; column = 0 }; column++ }
    output += char
  }
  return output
}
async function writeContext(root, directory, target, value, shared = null) {
  const textFiles = [], textDirectory = await safePath(root, `${directory}/text`)
  async function materialize(item, field) {
    if (typeof item === 'string' && JSON.stringify(item).length > 1200) {
      let file = shared?.files.get(item)
      if (!file) {
        const storage = shared?.directory ?? textDirectory
        await mkdir(storage, { recursive: true })
        const path = await safePath(root, resolve(storage, `text-${(shared?.files.size ?? textFiles.length) + 1}.txt`)), text = readingText(item)
        await writeFile(path, text, 'utf8')
        file = { path, lines: text.split('\n').length, wrapped: true }
        shared?.files.set(item, file)
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
  await writeFile(path, readingText(await P.textFile(originalPath)), 'utf8')
  return { path, originalPath, version: version.version, words: version.words, wrapped: true }
}
export async function writerText(root, project, job, data) {
  const repairing = ['repair', 'repair-length', 'repair-format'].includes(job.action)
  if (data.draftFile !== undefined) {
    if (typeof data.draftFile !== 'string' || data.text !== undefined || data.patches !== undefined || !/\.(md|txt)$/i.test(data.draftFile)) throw new Error('draftFile需要任务内MD/TXT文件，与text、patches互斥')
    if (repairing && !data.rewriteReason?.trim()) throw new Error('返修默认提交patches；引用整章草稿也需rewriteReason')
    const directory = await safePath(root, job.directory), path = await safePath(directory, within(directory, data.draftFile))
    if ((await requiredInputs(root, job)).some(item => P.local(root, item.path) === path)) throw new Error('draftFile只能引用本任务产出的草稿，不能把只读输入当作创作结果')
    const text = await P.textFile(path)
    if (!text.trim()) throw new Error('草稿为空')
    return text
  }
  if (data.patches !== undefined) {
    if (!repairing || data.text !== undefined || !Array.isArray(data.patches) || !data.patches.length) throw new Error('patches仅用于返修，不能同时提交text，且至少有一处修改')
    const version = P.latest(project, job.chapters[0])
    if (!version || version.version !== job.basis[0].version) throw new Error('返修底稿版本已变化，重新派单')
    let text = await P.textFile(P.local(root, version.path))
    for (const patch of data.patches) {
      if (typeof patch.before !== 'string' || !patch.before || typeof patch.after !== 'string') throw new Error('每处patch需要非空before与字符串after')
      const at = text.indexOf(patch.before)
      if (at < 0 || text.indexOf(patch.before, at + 1) >= 0) throw new Error('返修before必须在当前稿中唯一匹配，请扩大原句范围')
      text = text.slice(0, at) + patch.after + text.slice(at + patch.before.length)
    }
    return text
  }
  if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('文笔结果缺少text正文或返修patches')
  if (repairing && !data.rewriteReason?.trim()) throw new Error('返修默认提交patches保留原稿；确需整章重写须提供rewriteReason说明')
  return data.text
}
export async function inspectDraft(root, project, data) {
  const job = requireJob(project, data.task, '文笔', undefined, ['write', 'repair', 'repair-length', 'repair-format'])
  const directory = await safePath(root, job.directory)
  const path = await safePath(directory, within(directory, data.file))
  const raw = await P.textFile(path)
  const text = path.endsWith('.json') ? await writerText(root, project, job, JSON.parse(raw)) : raw
  const chapter = job.chapters[0], words = P.measure(text), current = P.latest(project, chapter)
  return { task: job.id, chapter, file: path, ...P.lengthInfo(project, chapter, words), currentWords: current?.words ?? null,
    changeWords: current ? words - current.words : null, policy: project.length,
    instruction: '汉字数由宿主精确计算，勿按字符或段数估算；按作者篇幅政策核对场景完整性，不凭比例增删或凑数。' }
}
export function requireJob(project, id, role, chapter, actions) {
  const job = project.jobs?.find(x => x.id === id)
  if (!job || job.role !== role || job.status !== 'running' || !job.agent || job.scopeRevision !== project.scope.revision ||
      chapter !== undefined && !job.chapters.includes(chapter) || actions && !actions.includes(job.action)) {
    throw new Error(`需要已绑定真实子代理的运行中${role}任务单 --task；队长只能派单与收集，不代写或自审`)
  }
  return job
}
function within(base, path) {
  const rel = relative(base, resolve(base, path))
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('任务文件路径越出分配目录')
  return resolve(base, path)
}
export function taskInfo(root, job) {
  return { ...job, directory: P.local(root, job.directory), promptPath: P.local(root, `${job.directory}/prompt.md`),
    resultPath: P.local(root, `${job.directory}/result.json`), contextPath: P.local(root, `${job.directory}/context.json`) }
}
export async function updateScopeJobs(root, project, previous, previousInterval) {
  const kept = [], cancelled = [], scope = project.scope, outlineCache = new Map()
  const narrowed = scope.from >= previous.from && scope.to <= previous.to && (scope.from !== previous.from || scope.to !== previous.to)
  for (const job of project.jobs.filter(item => ['pending', 'running'].includes(item.status))) {
    let valid = narrowed && scope.mode === previous.mode && !['pause', 'export'].includes(scope.mode) && project.interval === previousInterval &&
      scope.reviseApproved === Boolean(previous.reviseApproved) && ['文笔', '复核'].includes(job.role) && job.action !== 'final-review' &&
      job.scopeRevision === previous.revision && job.chapters.length > 0 && job.chapters.every(id => W.inScope(project, id))
    if (valid) try {
      for (const basis of job.basis) if ((P.latest(project, basis.chapter)?.version ?? null) !== basis.version ||
        !equal(await P.contract(root, project, basis.chapter, { outlineCache }), basis.contract)) { valid = false; break }
    } catch { valid = false }
    if (valid) {
      const path = await safePath(root, `.novel-workshop/read-receipts/${job.id}.json`)
      const receipt = existsSync(path) ? await P.jsonFile(path) : null
      if (receipt?.task === job.id && receipt.agent === job.agent && receipt.scopeRevision === previous.revision) {
        await writeFile(path, JSON.stringify({ ...receipt, scopeRevision: scope.revision }) + '\n', 'utf8')
      }
      job.scopeRevision = scope.revision
      job.reason = '仅缩小授权边界，本单章号及制作依据仍有效，保留原代理与结果继续收件'
      kept.push(job.id)
    } else {
      job.status = 'cancelled'; job.reason = '授权或任务依据已变化，保留产物后按新范围重新派单'; cancelled.push(job.id)
    }
  }
  return { kept, cancelled }
}

export async function requiredInputs(root, job) {
  const directory = await safePath(root, job.directory), files = new Map()
  const add = (path, lines = null) => { if (!files.has(path)) files.set(path, { path, lines }) }
  add(resolve(directory, 'prompt.md')); add(resolve(directory, 'context.json')); add(resolve(core, 'roles', `${job.role}.md`))
  async function packet(path) {
    const context = await P.jsonFile(await safePath(root, path))
    for (const item of context.textFiles ?? []) add(await safePath(directory, item.path), item.lines)
    if (context.manuscript?.path) add(await safePath(directory, context.manuscript.path))
    for (const item of context.packets ?? []) { add(await safePath(directory, item.path)); await packet(item.path) }
  }
  await packet(resolve(directory, 'context.json'))
  return [...files.values()]
}
export async function dispatch(root, project, data) {
  if (!roles[data.role]?.includes(data.action)) throw new Error('任务需要明确六岗位 role 与该岗位支持的 action')
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
  if (data.action === 'calibrate') {
    const target = P.calibrationTarget(project)
    if (!target || data.review && data.review !== target.review) throw new Error('没有匹配当前授权的待校准批次')
    if (!chapters.length) chapters = Array.from({ length: target.to - target.from + 1 }, (_, i) => target.from + i)
    if (chapters[0] !== target.from || chapters.at(-1) !== target.to || chapters.length !== target.to - target.from + 1) throw new Error('校准任务必须覆盖当前待校准范围')
  }
  if (data.role === '文笔' && chapters.length !== 1) throw new Error('每个文笔任务只处理一章，以便串行承接实际出章状态')
  if (data.role === '文笔' && !['continue', 'revise'].includes(project.scope.mode)) throw new Error('当前授权不允许文笔制作')
  const report = data.role === '文笔' ? await W.assertWriteReady(root, project, chapters[0]) : undefined
  if (data.role === '文笔' && ['repair', 'repair-length', 'repair-format'].includes(data.action) && W.openIssues(project, chapters[0]).some(P.issueBlocks) &&
    report.tasks.some(task => task.type === 'review' && task.chapters.includes(chapters[0])) &&
    !report.tasks.some(task => ['repair', 'repair-length', 'repair-format'].includes(task.type) && task.chapters.includes(chapters[0]))) throw new Error('当前返修已提交，先派独立复核确认旧问题，不能重复返修待验稿')
  const active = project.jobs.filter(x => ['pending', 'running'].includes(x.status) && x.scopeRevision === project.scope.revision)
  const duplicate = active.find(x => x.role === data.role && x.action === data.action && equal(x.chapters, chapters))
  if (duplicate) return taskInfo(root, duplicate)
  if (data.role === '文笔' && active.some(x => x.role === '文笔')) throw new Error('已有文笔任务，先收集实际结果再制作后章')
  const id = `job-${String(project.jobs.length + 1).padStart(4, '0')}`, directory = `.novel-workshop/tasks/${id}`
  const job = { id, directory, role: data.role, action: data.action, chapters, scopeRevision: project.scope.revision,
    status: 'pending', agent: null, time: new Date().toISOString(), review: data.review ?? null, basis: [] }
  const outlineCache = new Map()
  for (const chapter of chapters) job.basis.push({ chapter, version: P.latest(project, chapter)?.version ?? null, contract: await P.contract(root, project, chapter, { outlineCache }) })
  const full = await safePath(root, directory)
  await mkdir(full, { recursive: true })
  const shared = { directory: await safePath(root, `${directory}/text`), files: new Map() }
  let context
  if (data.role === '文笔' || data.action === 'outline') {
    context = await W.context(root, project, chapters[0], { report, outlineCache })
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
    context = { reviewDraft: { path: draft.path, data: reviewData }, packets, readingPaths: packets.map(item => item.manuscript), scope: project.scope,
      instruction: '逐章读取 packets 及其中 textFiles、manuscript 阅读视图；已包含细纲、底本、要求、事实及前章承接，按行 offset/limit 分页读取。阅读视图只增加长行换行，引用选不跨新增换行的原文短句，evidence.path必须使用originalPath；无需运行CLI。' }
  } else context = { diagnosis: await W.diagnose(root, project), scope: project.scope, chapters,
    parameters: { title: project.title, mode: project.mode, start: project.start, end: project.end, words: project.words, length: project.length, interval: project.interval },
    requirements: project.requirements.filter(item => item.status === 'active' && item.to >= project.scope.from && item.from <= project.scope.to),
    calibration: data.action === 'calibrate' ? P.calibrationTarget(project) : null,
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
    'result.json 写 {"notes":"实际注意事项","experience":"实际经验","exitState":{...},"entities":[],"factIds":[]}，按当前章稿补齐两更。' :
    `${context.repair ? 'result.json用patches提交定点修订；只有确需整章重写时才用text并附rewriteReason。' : 'result.json用text提交完整Markdown正文，含章标题。'}同时填写title、notes、experience、exitState及必要entities/factIds。`) :
    data.role === '复核' ? '使用reviewDraft.data作为结果模板，读取逐章材料包和正文；无需抄写contract或stamp，宿主按派单依据补齐并核实。verdict仅passed/rework；旧问题在resolutions逐项填open/resolved，resolved须给resolution及当前稿evidence。issues只新增新发现，跨章问题用affectedChapters列齐需要修改正文或出章状态的章，from/to覆盖其完整范围；只作背景引用的章不算待修范围。red必阻塞、yellow默认阻塞；可选建议用info或blocking:false说明理由。不得修改正文或主账。' :
    data.action === 'calibrate' ? '实际核对或更新当前待校准范围内细纲，把 {"outline":[已核对章号],"note":"复盘及调整依据","artifacts":[{"path":"任务目录内文件","target":"项目细纲相对路径"}]} 写入 result.json。' :
    '先分析context.documents的已有文档、候选与实际相关段落；已有成果可用时artifacts为空，不另建一份。需要补充时优先artifacts:[{target:"已有文档相对路径",patches:[{before:"唯一原句",after:"修改后原句"}]}]，或path指定任务内完整文件。新建同用途文件须createReason解释已有文件为何不能承载。result.json同时提供summary；来源与批准由队长登记。'
  await writeContext(root, directory, resolve(full, 'context.json'), context, shared)
  const inputs = await requiredInputs(root, job)
  const storedContext = await P.jsonFile(resolve(full, 'context.json'))
  await writeFile(resolve(full, 'context.json'), JSON.stringify({ requiredReads: inputs, ...storedContext }, null, 2) + '\n', 'utf8')
  const repairProtocol = data.role === '文笔' && context.repair && data.action !== 'finish' ? '\n返修result.json优先用patches:[{before:"当前稿唯一原句",after:"修改后原句"}]替代text，仍提交notes/experience/exitState；不涉及的正文由程序原样保留。' : ''
  const measureProtocol = data.role === '文笔' && data.action !== 'finish' ? '\n先在当前任务内分配各场景的内容与篇幅，再连续写成完整初稿；不要先写半章再逐句补到某个比例。自查发现的同轮修改集中完成；完整稿保存一次后按宿主计量处理实际缺口，不在每改一句后计量，也不为减少调用跳过必要修订。DSH保存result.json自动反馈；单独草稿可用novel_draft，Codex用draft-check，完整修订后再核对。已有唯一完整草稿也可用draftFile指向任务内MD/TXT文件替代text，免把全文再抄入JSON；两者互斥。' : ''
  await writeFile(await safePath(root, resolve(full, 'prompt.md')), `# ${id} · ${data.role} · ${data.action}\n\n项目：${root}\n章号：${chapters.join('、') || '当前授权范围'}\n\n你是独立的${data.role}子代理，不是主会话队长。先读岗位卡 ${resolve(core, 'roles', `${data.role}.md`)} 和本目录 context.json，按其中真实文件取证。\n仅在本任务目录 ${full} 内写文件；不得改项目登记、正式章稿、两更或别的任务目录。所有正式结果由队长 collect 串行提交。不要运行测试，不创建其他聊天，不转派本岗位工作。\n${data.role === '文笔' ? '只有你负责正文创作。' : '你不得创作或改写小说正文。'}\n\n${protocol}${repairProtocol}${measureProtocol}\n\n## 完整必读清单\n\n${inputs.map(item => `- ${item.path}${item.lines ? `（约${item.lines}行）` : ''}`).join('\n')}\n\n按清单逐份read，独立文件可在同一步并行读取；分页读到末尾。材料齐全后直接完成岗位工作，不额外读插件源码、整册或整份project.json查协议。\n\n完成后返回 result.json 绝对路径及≤200字结果摘要；没有材料或权限时明确报告阻塞，不伪造完成。\n`, 'utf8')
  project.jobs.push(job)
  await P.save(root, project)
  return taskInfo(root, job)
}
export async function updateTask(root, project, data) {
  const job = project.jobs.find(x => x.id === data.id)
  if (!job) throw new Error('任务单不存在')
  if (data.status === 'running') {
    if (!['pending', 'running'].includes(job.status) || job.scopeRevision !== project.scope.revision) throw new Error('任务已终止或授权已变化，请重新派单')
    if (typeof data.agent !== 'string' || !data.agent.trim()) throw new Error('启动任务需要原生子代理的实际 agent ID')
    if (job.agent && job.agent !== data.agent) throw new Error('不可替换运行中任务的子代理，先取消旧单再派新单')
    if (project.jobs.some(other => other.id !== job.id && other.agent === data.agent && other.role !== job.role)) throw new Error('六岗位使用独立子代理，不能复用其他岗位的执行者')
    if (job.role === '复核' && job.chapters.some(n => P.latest(project, n)?.authorAgent === data.agent)) throw new Error('复核子代理不能与本章文笔子代理相同')
    job.agent = data.agent
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
export async function collect(root, project, id) {
  const job = project.jobs.find(x => x.id === id)
  if (job?.status === 'completed') return { ...taskInfo(root, job), output: job.output }
  requireJob(project, id, job?.role)
  if (job.runtime === 'dsh-worker-v1') {
    const receipt = await P.jsonFile(await safePath(root, `.novel-workshop/read-receipts/${job.id}.json`)).catch(() => null)
    if (receipt?.complete !== true || receipt.task !== job.id || receipt.agent !== job.agent || receipt.scopeRevision !== job.scopeRevision) throw new Error('缺少真实worker完整阅读回执，不能收件；等待完成通知，缺料则记录失败后重新派发')
  }
  const data = await P.jsonFile(await safePath(root, `${job.directory}/result.json`))
  const chapter = job.chapters[0]
  const outlineCache = new Map()
  for (const basis of job.basis) {
    if (job.role === '文笔' && P.latest(project, basis.chapter)?.task === job.id || job.role === '复核' && project.reviews.some(x => x.task === job.id)) continue
    if ((P.latest(project, basis.chapter)?.version ?? null) !== basis.version || !equal(await P.contract(root, project, basis.chapter, { outlineCache }), basis.contract)) throw new Error('任务材料已变化，取消旧单并重新派发受影响岗位')
  }
  let output
  if (job.role === '文笔') {
    W.validateReceipt(data)
    if (job.action !== 'finish') {
      const current = P.latest(project, chapter)
      if (current?.task !== job.id) output = await W.writeChapter(root, project, chapter, await writerText(root, project, job, data), false, job.id)
      else output = { path: P.local(root, current.path), version: current.version }
    }
    const receipt = await W.finish(root, project, { ...data, chapter }, job.id)
    output = { ...output, receipt }
  } else if (job.role === '复核') {
    const old = project.reviews.find(x => x.task === job.id)
    const restored = { ...data, chapters: data.chapters?.map(row => ({ ...row,
      stamp: row.stamp ?? P.latest(project, row.chapter)?.stamp,
      contract: row.contract ?? job.basis.find(item => item.chapter === row.chapter)?.contract })) }
    output = old ? { review: old } : await W.submitReview(root, project, restored, job.id)
  } else {
    if (job.action !== 'calibrate' && !data.summary?.trim()) throw new Error('岗位结果需要 summary')
    if (job.action === 'calibrate' && Object.hasOwn(data, 'chapters')) throw new Error('批次校准任务不能提交作者熔断恢复 chapters')
    const pending = await prepareArtifacts(root, project, job, data)
    let calibration
    if (job.action === 'calibrate') {
      if (!equal([...new Set(data.outline ?? [])].sort((a, b) => a - b), job.chapters)) throw new Error('校准结果章号必须与任务单一致')
      calibration = await P.prepareCalibration(root, project, { outline: data.outline, note: data.note, review: job.review,
        source: { task: job.id, agent: job.agent } }, pending.map(item => item.to))
    }
    output = { summary: data.summary ?? data.note, files: await commitArtifacts(root, pending) }
    if (calibration) { project.calibrations.push(calibration); output.calibration = calibration }
  }
  job.status = 'completed'; job.output = output; job.updated = new Date().toISOString()
  await P.save(root, project)
  return { ...taskInfo(root, job), output }
}
