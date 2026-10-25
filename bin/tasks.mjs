import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as P from './project.mjs'
import * as W from './production.mjs'
import { safePath } from './paths.mjs'

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
async function writeContext(root, directory, target, value) {
  const textFiles = [], textDirectory = await safePath(root, `${directory}/text`)
  async function materialize(item, field) {
    if (typeof item === 'string' && JSON.stringify(item).length > 1200) {
      await mkdir(textDirectory, { recursive: true })
      const path = await safePath(root, resolve(textDirectory, `text-${textFiles.length + 1}.txt`)), text = readingText(item)
      await writeFile(path, text, 'utf8')
      textFiles.push({ field, path, lines: text.split('\n').length, wrapped: true })
      return `完整内容见 UTF-8 阅读文件：${path}`
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
  if (data.role === '文笔' && data.action !== 'finish') await W.assertWriteReady(root, project, chapters[0])
  const active = project.jobs.filter(x => ['pending', 'running'].includes(x.status) && x.scopeRevision === project.scope.revision)
  const duplicate = active.find(x => x.role === data.role && x.action === data.action && equal(x.chapters, chapters))
  if (duplicate) return taskInfo(root, duplicate)
  if (data.role === '文笔' && active.some(x => x.role === '文笔')) throw new Error('已有文笔任务，先收集实际结果再制作后章')
  const id = `job-${String(project.jobs.length + 1).padStart(4, '0')}`, directory = `.novel-workshop/tasks/${id}`
  const job = { id, directory, role: data.role, action: data.action, chapters, scopeRevision: project.scope.revision,
    status: 'pending', agent: null, time: new Date().toISOString(), review: data.review ?? null, basis: [] }
  for (const chapter of chapters) job.basis.push({ chapter, version: P.latest(project, chapter)?.version ?? null, contract: await P.contract(root, project, chapter) })
  const full = await safePath(root, directory)
  await mkdir(full, { recursive: true })
  let context
  if (data.role === '文笔' || data.action === 'outline') context = await W.context(root, project, chapters[0])
  else if (data.role === '复核') {
    const draft = await W.reviewDraft(root, project, chapters, data.action === 'final-review' ? 'final' : 'batch')
    const packets = [], packetDir = await safePath(root, `${directory}/chapters`)
    await mkdir(packetDir, { recursive: true })
    const sourceLines = project.source && await P.optionalStamp(P.local(root, project.source.path)) ?
      (await P.textFile(P.local(root, project.source.path), project.source.encoding)).split(/\r?\n/) : null
    for (const chapter of chapters) {
      const path = await safePath(root, resolve(packetDir, `${P.pad(chapter)}.json`))
      const manuscript = await safePath(root, resolve(packetDir, `${P.pad(chapter)}-body.txt`)), originalPath = P.local(root, P.latest(project, chapter).path)
      await writeFile(manuscript, readingText(await P.textFile(originalPath)), 'utf8')
      await writeContext(root, `${directory}/chapters/${P.pad(chapter)}-materials`, path, {
        ...await W.context(root, project, chapter, { diagnosis: false, sourceLines }), manuscript: { path: manuscript, originalPath, wrapped: true } })
      packets.push({ chapter, path, manuscript, originalPath })
    }
    context = { reviewDraft: draft, packets, readingPaths: packets.map(item => item.manuscript), scope: project.scope,
      instruction: '逐章读取 packets 及其中 textFiles、manuscript 阅读视图；已包含细纲、底本、要求、事实及前章承接，按行 offset/limit 分页读取。阅读视图只增加长行换行，引用选不跨新增换行的原文短句，evidence.path必须使用originalPath；无需运行CLI。' }
  } else context = { diagnosis: await W.diagnose(root, project), scope: project.scope, chapters,
    parameters: { title: project.title, mode: project.mode, start: project.start, end: project.end, words: project.words, length: project.length, interval: project.interval },
    requirements: project.requirements.filter(item => item.status === 'active' && item.to >= project.scope.from && item.from <= project.scope.to),
    calibration: data.action === 'calibrate' ? P.calibrationTarget(project) : null,
    readingPaths: ['00-状态.md', '.novel-workshop/当前要求.md', '01-设想.md', '02-人设/人物档案.md', '03-大纲.md', '04-文风.md', '05-总纲要.md',
      project.paths.notes, project.paths.experience, ...project.materials.filter(x => x.status === 'active').map(x => x.path)].map(p => P.local(root, p)) }
  if (data.action === 'calibrate') job.review = context.calibration?.review ?? data.review
  const protocol = data.role === '文笔' ? (data.action === 'finish' ?
    'result.json 写 {"notes":"实际注意事项","experience":"实际经验","exitState":{...},"entities":[],"factIds":[]}，按当前章稿补齐两更。' :
    'result.json 写 {"title":"章节标题","text":"完整 Markdown 正文，含章标题","notes":"实际注意事项","experience":"实际经验","exitState":{...},"entities":[],"factIds":[]}。') :
    data.role === '复核' ? '读取 context.json 中 reviewDraft.data，逐章读正文，填真实引文、评分和结论；把完整审阅 JSON 写入 result.json。不得修改正文或自行关闭问题。' :
    data.action === 'calibrate' ? '实际核对或更新当前待校准范围内细纲，把 {"outline":[已核对章号],"note":"复盘及调整依据","artifacts":[{"path":"任务目录内文件","target":"项目细纲相对路径"}]} 写入 result.json。' :
    'result.json 写 {"summary":"基于材料的工作结论","artifacts":[{"path":"任务目录内文件","target":"正式项目策划或细纲相对路径"}]}。无文件改动时 artifacts 可为空；需要登记的要求、事实、映射等在 summary 说明来源，由队长串行登记。'
  await writeContext(root, directory, resolve(full, 'context.json'), context)
  await writeFile(await safePath(root, resolve(full, 'prompt.md')), `# ${id} · ${data.role} · ${data.action}\n\n项目：${root}\n章号：${chapters.join('、') || '当前授权范围'}\n\n你是独立的${data.role}子代理，不是主会话队长。先读岗位卡 ${resolve(core, 'roles', `${data.role}.md`)} 和本目录 context.json，按其中真实文件取证。\n仅在本任务目录 ${full} 内写文件；不得改项目登记、正式章稿、两更或别的任务目录。所有正式结果由队长 collect 串行提交。不要运行测试，不创建其他聊天，不转派本岗位工作。\n${data.role === '文笔' ? '只有你负责正文创作。' : '你不得创作或改写小说正文。'}\n\n${protocol}\n\n完成后返回 result.json 绝对路径及简要结果；没有材料或权限时明确报告阻塞，不伪造完成。\n`, 'utf8')
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
  const outlines = job.chapters.map(id => P.local(root, project.chapters[id]?.outline ?? `${project.paths.outline}/第${P.pad(id)}章.md`))
  for (const item of data.artifacts ?? []) {
    if (typeof item.path !== 'string' || typeof item.target !== 'string') throw new Error('任务 artifacts 需要 path 和 target')
    const from = await safePath(taskRoot, within(taskRoot, item.path)), to = await safePath(root, within(root, item.target)), name = P.portable(root, to)
    if (/^AGENTS(?:\.override)?\.md$/i.test(basename(to))) throw new Error('岗位产物不能修改宿主指令文件')
    if (['calibrate', 'outline'].includes(job.action) && !outlines.includes(to)) throw new Error('本次动作只能提交任务单指定的细纲文件')
    const key = process.platform === 'win32' ? to.toLowerCase() : to
    if (destinations.has(key)) throw new Error('任务产物目标不能重复')
    destinations.add(key)
    if (!(plans[job.role] ?? []).some(prefix => prefix.endsWith('/') ? name.startsWith(prefix) : name === prefix) || !name.endsWith('.md')) throw new Error(`岗位无权提交该正式文件：${name}`)
    if (job.role === '剧情' && name.startsWith(project.paths.outline + '/')) {
      const match = name.match(/第(\d+)章\.md$/)
      if (!match || !W.inScope(project, Number(match[1])) || job.chapters.length && !job.chapters.includes(Number(match[1]))) throw new Error('细纲结果超出任务授权范围')
    }
    const content = await readFile(from)
    new TextDecoder('utf-8', { fatal: true }).decode(content)
    pending.push({ to, content })
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
  const data = await P.jsonFile(await safePath(root, `${job.directory}/result.json`))
  const chapter = job.chapters[0]
  for (const basis of job.basis) {
    if (job.role === '文笔' && P.latest(project, basis.chapter)?.task === job.id || job.role === '复核' && project.reviews.some(x => x.task === job.id)) continue
    if ((P.latest(project, basis.chapter)?.version ?? null) !== basis.version || !equal(await P.contract(root, project, basis.chapter), basis.contract)) throw new Error('任务材料已变化，取消旧单并重新派发受影响岗位')
  }
  let output
  if (job.role === '文笔') {
    W.validateReceipt(data)
    if (job.action !== 'finish') {
      if (!data.text?.trim()) throw new Error('文笔结果缺少完整 text 正文')
      const current = P.latest(project, chapter)
      if (current?.task !== job.id) output = await W.writeChapter(root, project, chapter, data.text, false, job.id)
      else output = { path: P.local(root, current.path), version: current.version }
    }
    const receipt = await W.finish(root, project, { ...data, chapter }, job.id)
    output = { ...output, receipt }
  } else if (job.role === '复核') {
    const old = project.reviews.find(x => x.task === job.id)
    output = old ? { review: old } : await W.submitReview(root, project, data, job.id)
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
