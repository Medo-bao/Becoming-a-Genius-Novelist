import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises'
import { resolve, join, relative, dirname, basename, extname } from 'node:path'
import { safePath, managedPath, inside } from './paths.mjs'
import * as D from './documents.mjs'

export const MANIFEST = '.novel-workshop/project.json'
export const pad = n => String(n).padStart(3, '0')
export function integer(value, label = '章号', minimum = 0) {
  const n = typeof value === 'boolean' ? NaN : Number(value)
  if (!Number.isSafeInteger(n) || n < minimum) throw new Error(`${label} 必须是 ≥${minimum} 的整数`)
  return n
}
export const local = (root, path) => resolve(root, path)
export const portable = (root, path) => relative(root, resolve(root, path)).replace(/\\/g, '/')
export async function textFile(path, encoding = 'utf-8') {
  return new TextDecoder(encoding, { fatal: true }).decode(await readFile(path)).replace(/^\uFEFF/, '')
}
export async function optional(path) {
  try { return await textFile(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
export async function jsonFile(path) { return JSON.parse(await textFile(path)) }
export async function stamp(path) {
  const info = await stat(path)
  return { size: info.size, mtime: info.mtimeMs }
}
export async function optionalStamp(path) {
  try { return await stamp(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export function sameStamp(a, b) { return a?.size === b?.size && a?.mtime === b?.mtime }
export function chapterText(text, fallback = '') {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const first = lines.findIndex(line => line.trim())
  const heading = first >= 0 && /^(?:#{1,6}\s+|第\s*[\d零〇一二三四五六七八九十百千万两]+\s*章|引子|序章|楔子)/.test(lines[first].trim())
  return { title: heading ? lines[first].trim().replace(/^#+\s*/, '') : fallback,
    body: (heading ? lines.slice(first + 1) : lines).join('\n').trim() }
}
export const han = text => (text.match(/\p{Script=Han}/gu) ?? []).length
export function measure(text) { return han(chapterText(text).body) }
export function chapterNumber(name) {
  let m = name.match(/^第(\d+)章-v([1-9]\d*)\.(md|txt)$/i)
  if (m) return { chapter: Number(m[1]), version: Number(m[2]) }
  m = name.match(/^(\d+)(?:[ _-][^/]*)?\.(md|txt)$/i) ?? name.match(/^第(\d+)章(?:[ _][^/]*)?\.(md|txt)$/i)
  return m ? { chapter: Number(m[1]), version: 1 } : null
}
export async function scan(root, bodyPath, project = null) {
  const dir = local(root, bodyPath), rows = []
  if (!existsSync(dir)) return rows
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const id = entry.isFile() && chapterNumber(entry.name)
    if (id) {
      const path = portable(root, join(dir, entry.name)), key = value => process.platform === 'win32' ? value.toLowerCase() : value
      // 数字TXT可以是已明确登记的后续采用版，不能再次按文件名降成v1。
      const registered = project?.chapters[id.chapter]?.versions.findLast(version => key(portable(root, version.path)) === key(path))
      rows.push({ ...id, version: registered?.version ?? id.version, path: registered?.path ?? path })
    }
  }
  return rows.sort((a, b) => a.chapter - b.chapter || a.version - b.version)
}
export function latest(project, chapter) {
  return project.chapters[String(chapter)]?.versions.at(-1) ?? null
}
export function chapterIds(project) {
  return Object.keys(project.chapters).map(Number).filter(id => latest(project, id)).sort((a, b) => a - b)
}
export function nextChapter(project) {
  let id = project.start
  while (latest(project, id)) id++
  return id
}
export function templateProject(root, options = {}) {
  const start = integer(options.start ?? 1), end = integer(options.end ?? 120)
  if (end < start) throw new Error('结束章号不能小于起始章号')
  return { schemaVersion: 1, revision: 0, title: options.title || basename(root), mode: options.mode || '原创',
    start, end, words: integer(options.words ?? 4000, '章均字数', 1), interval: integer(options.interval ?? 5, '验收间隔', 1),
    length: { type: options.mode === '改编精修' ? 'source' : 'fixed', minRatio: null, maxRatio: null },
    metadata: { author: '', description: '', language: 'zh-CN', cover: null },
    paths: { body: '09-正文', outline: '06-细纲', notes: '07-注意事项.md', experience: '08-经验文档.md', reports: '10-验收', output: '11-成书' },
    gates: {}, source: null, chapters: {}, requirements: [], facts: [], issues: [], experiences: [], materials: [],
    exceptions: [], calibrations: [], maxRepairRounds: 3, parameters: {}, jobs: [],
    scope: { revision: 0, mode: 'pause', from: start, to: end, deliver: false, source: '尚未登记制作授权' },
    scopeHistory: [], reviews: [], exports: [], checkpoint: null, autoArchive: true, archives: [], cleanupScope: null }
}
export async function load(root) {
  if (!existsSync(local(root, MANIFEST))) throw new Error('项目尚未登记，请先运行 doctor 自动识别，再用 init 或 import 接手')
  const project = await jsonFile(await safePath(root, MANIFEST))
  if (project.schemaVersion !== 1) throw new Error('不支持此项目登记版本')
  project.exceptions ??= []
  project.calibrations ??= []
  project.maxRepairRounds ??= 3
  project.parameters ??= {}
  project.jobs ??= []
  project.documents ??= {}
  project.autoArchive ??= true
  project.archives ??= []
  if (project.progressFiles === undefined) await D.discoverProgress(root, project)
  for (const issue of project.issues.filter(item => item.status === 'open')) {
    const range = issueRange(issue)
    if (range.from < project.start || range.to > project.end || range.to < range.from) throw new Error('问题影响范围超出全书计划')
    Object.assign(issue, range)
  }
  return project
}
export function confirmParameters(project, values, source) {
  project.parameters ??= {}
  if (source === undefined || source === null || typeof source === 'string' && !source.trim()) return
  for (const key of values) project.parameters[key] = { source, time: new Date().toISOString() }
}
export function missingParameters(project) {
  const labels = { mode: '制作模式：原创还是改编精修', plan: '全书范围：起始章号与终止章号（或总章数）',
    length: '篇幅政策：固定章均字数，或按底本场景完整度决定；如有比例限制请说明', interval: '审查间隔：每几章复审（尾批自动复审）' }
  return Object.entries(labels).filter(([key]) => !project.parameters?.[key]?.source).map(([key, question]) => ({ key, question }))
}
export function calibrationTarget(project) {
  if (project.scope.mode !== 'continue') return null
  const { from, to } = project.scope
  for (const review of [...project.reviews].reverse()) {
    if (review.verdict !== 'passed' || review.kind === 'final') continue
    const covered = review.chapters.map(row => row.chapter).filter(id => id >= from && id <= to)
    if (!covered.length) continue
    const done = Math.max(...covered), start = Math.max(from, done + 1), end = Math.min(to, done + project.interval)
    if (start > end) return null
    if (project.calibrations.some(x => x.review === review.id && x.scopeRevision === project.scope.revision && x.from === start && x.to === end)) return null
    return { review: review.id, from: start, to: end }
  }
  return null
}
export function repairStreaks(project) {
  const counts = new Map()
  const resets = new Map()
  for (const item of project.calibrations) if (item.kind === 'repair-reset') for (const id of item.chapters) resets.set(id, item.reviewCount)
  for (let i = 0; i < project.reviews.length; i++) {
    const review = project.reviews[i]
    for (const row of review.chapters ?? []) {
      if (row.chapter < project.scope.from || row.chapter > project.scope.to || i < (resets.get(row.chapter) ?? 0)) continue
      counts.set(row.chapter, review.verdict === 'passed' ? 0 : (counts.get(row.chapter) ?? 0) + 1)
    }
  }
  return [...counts].filter(([, count]) => count >= project.maxRepairRounds).map(([chapter]) => chapter).sort((a, b) => a - b)
}
export async function save(root, project) {
  project.revision++
  await D.syncProgress(root, project)
  const path = await safePath(root, MANIFEST)
  await mkdir(dirname(path), { recursive: true })
  await safePath(root, path + '.tmp')
  await writeFile(path + '.tmp', JSON.stringify(project, null, 2) + '\n', 'utf8')
  await rename(path + '.tmp', path)
  await views(root, project)
}
export async function views(root, project) {
  const ids = chapterIds(project), next = nextChapter(project)
  const scope = project.scope
  const gateRows = [0, 1, 2, 3, 4, 5].map(n => `| G${n} | ${project.gates[n]?.passed ? '通过' : '未通过'} | ${project.gates[n]?.evidence ?? ''} |`)
  const summary = `# 状态 · ${project.title}\n\n> 由项目登记自动生成，使用 CLI 更新；权威数据：${MANIFEST}。\n\n- 书名：${project.title}\n- 渠道：${project.mode}\n- 章均字数：${project.words}\n- 验收间隔：${project.interval} 章\n- 计划章号：${project.start}—${project.end}（${project.end - project.start + 1} 个位置）\n- 已落盘：${ids.length} 个位置\n- 下一空缺章：${next > project.end ? '无' : next}\n- 当前授权：${scope.mode}，${scope.from}—${scope.to}，版本 ${scope.revision}\n- 授权依据：${scope.source}\n- 待处理问题：${project.issues.filter(x => x.status === 'open').length}\n\n## 阶段门\n\n| 门 | 状态 | 依据 |\n|---|---|---|\n${gateRows.join('\n')}\n\n## 会话交接\n\n${project.checkpoint ? JSON.stringify(project.checkpoint, null, 2) : '启动 doctor 获取下一步；无需重述已登记的要求。'}\n`
  const lastArchive = project.archives?.at(-1)
  await writeFile(await safePath(root, '00-状态.md'), summary + (lastArchive ? `\n## 过程资料归档\n\n最近归档：[查看归档清单](${lastArchive.index})（${lastArchive.files}个文件）。历史任务用task --id查询归档后的路径。\n` : ''), 'utf8')
  await writeFile(await safePath(root, '.novel-workshop/参数与派单.md'), `# 参数与派单\n\n${['mode', 'plan', 'length', 'interval'].map(key => `- ${key}：${project.parameters?.[key]?.source ? JSON.stringify(project.parameters[key].source) : '未规定，显示的默认值只是占位'}`).join('\n')}\n\n## 未收集任务\n\n${(project.jobs ?? []).filter(x => ['pending', 'running'].includes(x.status)).map(x => `- ${x.id} · ${x.role} · ${x.action} · ${x.status} · ${x.agent ?? '尚未绑定实际子代理'} · ${x.directory}/result.json`).join('\n') || '无'}\n`, 'utf8')
  const active = project.requirements.filter(x => x.status === 'active')
  await writeFile(await safePath(root, '.novel-workshop/当前要求.md'), `# 当前有效要求\n\n${active.map(x => `- ${x.id} r${x.revision}（${x.from}—${x.to}）：${x.text}\n  依据：${JSON.stringify(x.source)}`).join('\n')}\n`, 'utf8')
}
export async function discover(root) {
  const candidates = []
  for (const body of ['09-正文', '正文改编/章节', '章节']) {
    const rows = await scan(root, body)
    if (rows.length) candidates.push({ body, positions: new Set(rows.map(r => r.chapter)).size, first: rows[0].chapter, last: rows.at(-1).chapter })
  }
  const ledger = existsSync(join(root, '正文改编/进度.json')) ? await jsonFile(join(root, '正文改编/进度.json')) : null
  const differences = []
  if (ledger?.已处理位置数 !== undefined && candidates[0] && ledger.已处理位置数 !== candidates[0].positions) differences.push({ code: 'legacy-progress-mismatch', diskPositions: candidates[0].positions, ledgerPositions: ledger.已处理位置数, reason: '物理落盘与旧进度不同，接手时核对未登记、暂存或中断稿；不推断验收状态' })
  const documents = await D.inventory(root)
  return { registered: existsSync(local(root, MANIFEST)), candidates, differences, documents: D.summary(documents),
    hasPlanningDocuments: documents.items.some(item => !item.archived && item.kinds.some(kind => kind === 'chapters' || Object.hasOwn(D.purposes, kind))),
    references: ['docs/README.md', 'docs/现行要求与执行计划.md', 'docs/经验与注意事项.md', 'PROJECT_NOTES.md'].filter(p => existsSync(local(root, p))),
    legacy: ledger ? { title: basename(root), source: ledger.底本, totalPositions: ledger.总位置数, next: ledger.下一个章号, instruction: ledger.当前执行范围, reviewInterval: ledger.十章复审 ? 10 : null } : null }
}
function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value)
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 }
  let sum = 0, part = 0, n = 0
  for (const c of value) {
    if (c in digits) n = digits[c]
    else if (c === '万') { sum += (part + n) * 10000; part = n = 0 }
    else if (c in units) { part += (n || 1) * units[c]; n = 0 }
  }
  return sum + part + n
}
function outlineDocument(text) {
  const lines = text?.split(/\r?\n/) ?? [], headings = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*#{1,6}\s+第\s*([\d零〇一二三四五六七八九十百千万两]+)\s*章/) ??
      lines[i].match(/^第\s*([\d零〇一二三四五六七八九十百千万两]+)\s*章(?:\s|[、：:.]|$)/)
    if (match) headings.push({ chapter: chineseNumber(match[1]), start: i })
  }
  for (let i = 0; i < headings.length; i++) headings[i].end = headings[i + 1]?.start ?? lines.length
  return { text, lines, headings }
}
function outlineReferences(document, chapter) {
  const { lines, headings } = document
  const current = headings.length ? headings.filter(item => item.chapter === chapter) : [{ start: 0, end: lines.length }]
  const related = new Set()
  for (const item of current) for (const line of lines.slice(item.start, item.end)) {
    if (!/关联章号/.test(line)) continue
    for (const match of line.matchAll(/第\s*([\d零〇一二三四五六七八九十百千万两]+)\s*章/g)) related.add(chineseNumber(match[1]))
    const list = line.split(/关联章号\s*[：:]/)[1]?.replace(/[*`]/g, '').trim()
    if (list && /^[\d零〇一二三四五六七八九十百千万两\s、,，/]+$/.test(list)) {
      for (const value of list.split(/[\s、,，/]+/).filter(Boolean)) related.add(chineseNumber(value))
    }
  }
  return [...related]
}
function selectOutline(document, wanted) {
  const { text, lines, headings } = document
  if (!text) return { text, ranges: [] }
  if (!headings.length) return { text, ranges: [{ start: 1, end: lines.length }] }
  const selected = headings.filter(item => wanted.has(item.chapter))
  const ranges = [...(headings[0].start ? [{ start: 1, end: headings[0].start }] : []),
    ...selected.map(item => ({ chapter: item.chapter, start: item.start + 1, end: item.end }))]
  return { text: ranges.map(item => lines.slice(item.start - 1, item.end).join('\n')).join('\n\n'), ranges }
}
export function outlineSlice(text, chapter, dependencies = []) {
  const document = outlineDocument(text)
  if (!document.headings.length) return selectOutline(document, new Set([chapter]))
  if (!document.headings.some(item => item.chapter === chapter)) throw new Error(`细纲文件中没有第${pad(chapter)}章条目，请先修正本章映射`)
  const wanted = new Set([chapter - 1, chapter, chapter + 1, ...dependencies, ...outlineReferences(document, chapter)])
  return { ...selectOutline(document, wanted),
    relatedChapters: [...wanted].filter(id => id >= 0 && !document.headings.some(item => item.chapter === id)) }
}
/** 只补本章直接关联；批次共用 outlineCache，复用细纲文件与目录读取。 */
export async function outlineContext(root, project, chapter, options = {}) {
  chapter = integer(chapter)
  const cache = options.outlineCache ?? new Map()
  const cached = (key, read) => {
    if (!cache.has(key)) cache.set(key, read())
    return cache.get(key)
  }
  const readOutline = path => cached(`outline:file:${path}`, async () => outlineDocument(await optional(path)))
  const path = await existingOutline(root, project, chapter, { ...options, outlineCache: cache })
  const document = await readOutline(path)
  if (document.headings.length && !document.headings.some(item => item.chapter === chapter)) {
    throw new Error(`细纲文件中没有第${pad(chapter)}章条目，请先修正本章映射`)
  }
  const adjacent = [chapter - 1, chapter + 1].filter(id => id >= (project.start ?? 0) && id <= (project.end ?? Infinity))
  const direct = new Set([...(project.chapters[chapter]?.dependencies ?? []), ...outlineReferences(document, chapter)]
    .map(Number).filter(id => Number.isSafeInteger(id) && id >= 0))
  const wanted = new Set([chapter, ...adjacent, ...direct])
  const inDocument = id => document.headings.some(item => item.chapter === id) || !document.headings.length && Boolean(document.text) &&
    (id === chapter || project.chapters[id]?.outline && local(root, project.chapters[id].outline) === path)
  const outside = [...wanted].filter(id => id !== chapter && !inDocument(id))
  const found = new Map(), pending = []
  const contains = (doc, id, singleChapter) => Boolean(doc.text) && (doc.headings.some(item => item.chapter === id) || !doc.headings.length && singleChapter === id)
  for (const id of outside) {
    const mapped = project.chapters[id]?.outline
    if (!mapped) { pending.push(id); continue }
    const full = local(root, mapped), doc = await readOutline(full)
    if (contains(doc, id, id)) found.set(id, { path: full, document: doc })
  }
  if (pending.length) {
    const directory = dirname(path)
    const entries = await cached(`outline:directory:${directory}`, async () => {
      try { return await readdir(directory, { withFileTypes: true }) }
      catch (error) { if (error.code === 'ENOENT') return []; throw error }
    })
    const candidates = new Map()
    for (const [id, row] of Object.entries(project.chapters)) if (row.outline) {
      const full = local(root, row.outline)
      if (!candidates.has(full)) candidates.set(full, new Set())
      candidates.get(full).add(Number(id))
    }
    for (const entry of entries) if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      const full = join(directory, entry.name)
      if (!candidates.has(full)) candidates.set(full, new Set())
      const named = entry.name.match(/^第\s*([\d零〇一二三四五六七八九十百千万两]+)\s*章/) ?? entry.name.match(/^(\d+)\.md$/i)
      if (named) candidates.get(full).add(chineseNumber(named[1]))
    }
    candidates.delete(path)
    const matches = new Map(pending.map(id => [id, []]))
    for (const [full, mappedChapters] of candidates) {
      const doc = await readOutline(full)
      for (const id of pending) if (contains(doc, id, mappedChapters.has(id) ? id : null)) matches.get(id).push({ path: full, document: doc })
    }
    // 多份未明确映射的材料同时命中时留作缺口，不用文件排序猜哪份是现行细纲。
    for (const [id, matchesForChapter] of matches) if (matchesForChapter.length === 1) found.set(id, matchesForChapter[0])
  }
  const groups = new Map()
  for (const [id, entry] of found) {
    if (!groups.has(entry.path)) groups.set(entry.path, { ...entry, chapters: new Set() })
    groups.get(entry.path).chapters.add(id)
  }
  return { outline: { path, ...selectOutline(document, wanted), relatedChapters: outside },
    relatedOutlines: [...groups.values()].map(entry => ({ path: entry.path, ...selectOutline(entry.document, entry.chapters),
      chapters: [...entry.chapters].sort((a, b) => a - b), requiredChapters: [...entry.chapters].filter(id => direct.has(id)).sort((a, b) => a - b) })),
    missingRelatedChapters: outside.filter(id => direct.has(id) && !found.has(id)).sort((a, b) => a - b) }
}
export async function existingOutline(root, project, chapter, options = {}) {
  const explicit = project.chapters[chapter]?.outline, fallback = local(root, `${project.paths.outline}/第${pad(chapter)}章.md`)
  if (explicit) return local(root, explicit)
  const binding = project.outlines?.find(item => item.from <= chapter && item.to >= chapter)
  if (binding) {
    const path = await safePath(root, binding.path)
    if (!existsSync(path)) throw new Error(`已绑定细纲不存在：${binding.path}；恢复原文件或config更新outlines，不另建同类文件`)
    return path
  }
  if (existsSync(fallback)) return fallback
  const cache = options.outlineCache ?? new Map(), found = await D.inventory(root, project, { cache })
  const matches = []
  for (const item of found.items.filter(item => !item.archived && !item.reference && item.kinds.includes('chapters'))) {
    const path = local(root, item.path), key = `outline:file:${path}`
    if (!cache.has(key)) cache.set(key, optional(path).then(outlineDocument))
    const document = await cache.get(key)
    if (document.headings.some(item => item.chapter === chapter)) matches.push(path)
  }
  if (matches.length > 1) {
    const error = new Error(`第${pad(chapter)}章已有多份细纲候选；先用documents分析并用map选定，不另建同类文件`)
    Object.assign(error, { code: 'DOCUMENT_CHOICE', chapter, candidates: matches.map(path => portable(root, path)) })
    throw error
  }
  return matches[0] ?? fallback
}
export async function bindOutlines(root, project, bindings, source) {
  if (!Array.isArray(bindings) || typeof source !== 'string' || !source.trim()) throw new Error('outlines需要范围绑定数组及source选择依据')
  const prepared = []
  for (const item of bindings) {
    if (typeof item.path !== 'string' || !/\.(md|txt)$/i.test(item.path)) throw new Error('细纲绑定需要已有MD/TXT路径')
    const path = await safePath(root, item.path), from = integer(item.from), to = integer(item.to)
    if (from < project.start || to > project.end || to < from || prepared.some(old => old.from <= to && old.to >= from)) throw new Error('细纲绑定范围须在全书内且不能重叠；逐章map可覆盖册级绑定')
    if (['body', 'reports', 'output'].some(kind => inside(local(root, project.paths[kind]), path)) ||
      inside(local(root, '.novel-workshop'), path) || project.progressFiles?.includes(portable(root, path)) || /^AGENTS(?:\.override)?\.md$/i.test(basename(path))) throw new Error('细纲不能绑定正文、进度或运行文件')
    const document = outlineDocument(await textFile(path))
    for (let id = from; id <= to; id++) if (!document.headings.some(heading => heading.chapter === id)) throw new Error(`绑定文件未包含第${pad(id)}章细纲，请缩小范围或补齐真实资料`)
    prepared.push({ path: portable(root, path), from, to, source: item.source ?? source })
  }
  project.outlines = prepared
}
export function issueRange(issue) {
  let from = integer(issue.from), to = integer(issue.to ?? from)
  if (issue.affectedChapters !== undefined) {
    if (!Array.isArray(issue.affectedChapters) || !issue.affectedChapters.length) throw new Error('affectedChapters需要实际受影响章号数组')
    const ids = issue.affectedChapters.map(id => integer(id))
    from = Math.min(from, ...ids); to = Math.max(to, ...ids)
  }
  // 接回明确写在问题标题中的跨章范围，避免说明要求联动而结构化字段漏掉后章。
  const heading = String(issue.text ?? '').split(/[。\n]/, 1)[0]
  if (/跨章|交接|接续|联动/.test(heading)) for (const match of heading.matchAll(/[（(](?:第)?(\d+)(?:章)?\s*[—–~～至-]\s*(?:第)?(\d+)(?:章)?[）)]/g)) {
    from = Math.min(from, Number(match[1])); to = Math.max(to, Number(match[2]))
  }
  return { from, to }
}
export const issueBlocks = issue => issue.severity === 'red' || (issue.blocking ?? issue.severity !== 'info')
export async function sourceIndex(root, path, encoding = 'utf-8') {
  const full = await textFile(local(root, path), encoding), lines = full.split(/\r?\n/), headings = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/^#{1,6}\s*/, '')
    const m = line.match(/^第\s*([\d零〇一二三四五六七八九十百千万两]+)\s*章(?:\s|[、：:.]|$)(.*)$/)
    if (m) headings.push({ chapter: chineseNumber(m[1]), title: line, start: i + 1 })
    else if (/^(?:引子|序章|楔子)(?:\s|[、：:.]|$)/.test(line)) headings.push({ chapter: 0, title: line, start: i + 1 })
  }
  if (!headings.length) throw new Error('底本没有可识别章标题；请提供含“第N章”或“引子”标题的底本')
  const chapters = {}
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i], end = (headings[i + 1]?.start ?? lines.length + 1) - 1
    const segment = { start: h.start, end }
    const item = chapters[h.chapter] ??= { title: h.title, segments: [], words: 0 }
    item.segments.push(segment)
    item.words += measure(lines.slice(h.start - 1, end).join('\n'))
  }
  return { path: portable(root, local(root, path)), encoding, stamp: await stamp(local(root, path)), chapters }
}
export async function sourceSlices(root, project, ids, sourceLines = null) {
  if (!project.source) return []
  const lines = sourceLines ?? (await textFile(local(root, project.source.path), project.source.encoding)).split(/\r?\n/)
  return ids.flatMap(id => (project.source.chapters[id]?.segments ?? []).map(s => ({ chapter: Number(id), ...s,
    path: local(root, project.source.path), text: lines.slice(s.start - 1, s.end).join('\n') })))
}
export async function registerFiles(root, project) {
  const added = [], duplicates = [], rows = await scan(root, project.paths.body, project), seen = new Map()
  const keyPath = value => process.platform === 'win32' ? value.toLowerCase() : value
  // 先核对整批冲突，再登记，避免半批被当成已接手。
  for (const row of rows) {
    if (row.chapter < project.start || row.chapter > project.end) continue
    const key = `${row.chapter}:${row.version}`, old = seen.get(key) ?? project.chapters[row.chapter]?.versions.find(version => version.version === row.version)?.path
    if (old && keyPath(old) !== keyPath(row.path)) duplicates.push(`${old} ↔ ${row.path}`)
    seen.set(key, row.path)
  }
  if (duplicates.length) throw new Error(`同一章节版本存在多个文件：${duplicates.join('、')}；已登记采用路径优先，未登记的真实歧义须按现行资料确定，不能用finish绕过`)
  for (const row of rows) {
    if (row.chapter < project.start || row.chapter > project.end) continue
    const chapter = project.chapters[row.chapter] ??= { sourceIds: project.source?.chapters[row.chapter] ? [row.chapter] : [], treatment: '待核对', baselineTreatment: '待核对', dependencies: [], factIds: [], entities: [], versions: [] }
    const old = chapter.versions.find(v => v.version === row.version)
    if (old) continue
    const text = await textFile(local(root, row.path))
    chapter.versions.push({ version: row.version, path: row.path, stamp: await stamp(local(root, row.path)), words: measure(text), title: chapterText(text, `第${pad(row.chapter)}章`).title, receipt: null })
    chapter.versions.sort((a, b) => a.version - b.version)
    added.push(row)
  }
  return added
}
export function relevant(project, kind, chapter) {
  const row = project.chapters[chapter]
  return project[kind].filter(x => x.status === 'active' && x.from <= chapter && x.to >= chapter &&
    (kind !== 'facts' || !x.entities?.length || x.entities.some(e => row?.entities?.includes(e)) || row?.factIds?.includes(x.id)))
}
export function dependencies(project, chapter) {
  return [...relevant(project, 'requirements', chapter), ...relevant(project, 'facts', chapter)]
    .map(x => ({ id: x.id, revision: x.revision })).sort((a, b) => a.id.localeCompare(b.id))
}
export async function contract(root, project, chapter, options = {}) {
  const row = project.chapters[chapter]
  const outlines = options.outlineContext ?? await outlineContext(root, project, chapter, options)
  const path = outlines.outline.path
  const documentBindings = []
  for (const kind of ['world', 'characters', 'style']) {
    const binding = project.documents?.[kind]
    if (binding) documentBindings.push({ kind, path: binding.path, stamp: await optionalStamp(local(root, binding.path)) })
  }
  const relatedOutlines = []
  // 相邻章是阅读参考；后续新建其细纲不应使已通过的前批次重新复核。
  for (const entry of outlines.relatedOutlines.filter(entry => entry.requiredChapters.length)) relatedOutlines.push({ path: portable(root, entry.path), stamp: await optionalStamp(entry.path) })
  const ids = [...new Set([...(row?.dependencies ?? []), ...(row?.entryState == null && chapter > project.start ? [chapter - 1] : [])])].sort((a, b) => a - b)
  const linkedChapters = []
  for (const id of ids) {
    const version = latest(project, id)
    linkedChapters.push({ chapter: id, version: version?.version ?? null, path: version?.path ?? null,
      stamp: version ? await optionalStamp(local(root, version.path)) : null, exitState: project.chapters[id]?.exitState ?? null })
  }
  return { mode: project.mode, records: dependencies(project, chapter), outline: existsSync(local(root, path)) ? await stamp(local(root, path)) : null,
    ...(documentBindings.length ? { documents: documentBindings } : {}),
    ...(relatedOutlines.length ? { relatedOutlines } : {}),
    ...(outlines.missingRelatedChapters.length ? { missingRelatedChapters: outlines.missingRelatedChapters } : {}),
    lengthPolicy: { words: project.words, ...project.length },
    mapping: { sourceIds: row?.sourceIds ?? [], treatment: row?.treatment ?? '待核对', dependencies: row?.dependencies ?? [] },
    entryState: row?.entryState ?? null, exitState: row?.exitState ?? null, linkedChapters,
    exceptions: (project.exceptions ?? []).filter(x => x.status === 'approved' && x.from <= chapter && x.to >= chapter).map(x => ({ id: x.id, revision: x.revision })),
    source: project.source ? { path: project.source.path, indexed: project.source.stamp, current: await optionalStamp(local(root, project.source.path)) } : null }
}
export function lengthInfo(project, chapter, words) {
  const ids = project.chapters[chapter]?.sourceIds ?? (project.source?.chapters[chapter] ? [chapter] : [])
  const target = project.length.type === 'source' ? ids.reduce((sum, id) => sum + (project.source?.chapters[id]?.words ?? 0), 0) : project.words
  const ratio = target ? words / target : null
  if (project.length.type === 'source') {
    const red = (project.length.minRatio !== null && ratio !== null && ratio < project.length.minRatio) ||
      (project.length.maxRatio !== null && ratio !== null && ratio > project.length.maxRatio)
    return { target, words, ratio, verdict: !target && project.chapters[chapter]?.treatment !== '新增' ? '缺底本' : red ? '红' : '待内容判断' }
  }
  return { target, words, ratio, verdict: ratio >= .9 && ratio <= 1.1 ? '绿' : ratio >= .8 && ratio <= 1.2 ? '黄' : '红' }
}
export async function versionValid(root, version) {
  try { return sameStamp(version.stamp, await stamp(local(root, version.path))) && version.words === measure(await textFile(local(root, version.path))) }
  catch (e) { if (e.code === 'ENOENT') return false; throw e }
}
export async function evidence(root, item) {
  if (!item?.path || !item.quote?.trim()) throw new Error('证据需要 path 与非空 quote')
  const text = await textFile(local(root, item.path))
  if (!text.includes(item.quote)) throw new Error(`引文不在证据文件中：${item.path}`)
  return { ...item, path: portable(root, local(root, item.path)), stamp: await stamp(local(root, item.path)) }
}
export async function record(root, project, kind, data) {
  const names = { requirement: 'requirements', fact: 'facts', issue: 'issues', experience: 'experiences', material: 'materials', exception: 'exceptions' }
  const name = names[kind]
  if (!name) throw new Error('record kind 支持 requirement、fact、issue、experience、material、exception')
  if (!data.text?.trim() && kind !== 'material') throw new Error('记录缺少 text')
  const old = project[name].find(x => x.id === data.id)
  const id = data.id ?? `${kind[0].toUpperCase()}${project[name].length + 1}`
  const temporary = kind === 'material' && data.temporary === true
  const initialRange = { ...old, ...data, from: data.from ?? old?.from ?? (temporary ? project.scope.from : project.start), to: data.to ?? old?.to ?? (temporary ? project.scope.to : project.end) }
  const { from, to } = kind === 'issue' ? issueRange(initialRange) : { from: integer(initialRange.from), to: integer(initialRange.to) }
  if (to < from || from < project.start || to > project.end) throw new Error('记录作用范围超出计划章号')
  const defaults = { issue: 'open', exception: 'pending' }
  const item = { ...old, ...data, id, from, to, revision: (old?.revision ?? 0) + 1,
    status: data.status ?? old?.status ?? defaults[kind] ?? 'active', history: old ? [...(old.history ?? []), { ...old, history: undefined }] : [] }
  const allowed = { issue: ['open', 'resolved', 'retracted', 'superseded'], exception: ['pending', 'approved', 'rejected', 'withdrawn'], material: ['active', 'superseded', 'retired', 'archived'] }
  if (allowed[kind] ? !allowed[kind].includes(item.status) : !['active', 'superseded', 'retired'].includes(item.status)) throw new Error('记录状态不合法')
  if (kind === 'issue') {
    if (item.status !== 'open' && !data.resolution?.trim()) throw new Error('关闭或撤销问题需要 resolution 说明')
    item.severity ??= 'red'
    item.requiresUser ??= false
    if (item.blocking !== undefined && typeof item.blocking !== 'boolean' || item.severity === 'red' && item.blocking === false) throw new Error('blocking为布尔值，红项必须阻塞')
  }
  if (kind === 'exception') {
    if (!item.cost?.trim()) throw new Error('破格申请必须写清代价 cost：这条突破会让什么失效或付出什么')
    if (item.status !== 'pending' && !item.source) throw new Error('裁决破格申请需要记录 source（用户或编辑决定的依据）')
  }
  if (['fact', 'issue'].includes(kind) && item.status !== 'retracted' && item.status !== 'superseded') item.evidence = await evidence(root, data.evidence ?? old?.evidence)
  if (kind === 'requirement' && !item.source) throw new Error('要求必须记录用户指示或文档来源 source')
  if (kind === 'material') {
    if (data.status === 'archived' && old?.status !== 'archived') throw new Error('资料须由archive实际归档，不能手填archived冒充完成')
    if (!['source', 'analysis', 'adaptation'].includes(item.kind) || !item.path || item.status === 'active' && !existsSync(local(root, item.path))) throw new Error('有效资料需要存在的 path 和 source/analysis/adaptation 类型 kind')
    item.path = portable(root, local(root, item.path))
    item.origin ??= item.kind === 'adaptation' ? 'adaptation' : 'original'
    if (item.temporary !== undefined && typeof item.temporary !== 'boolean') throw new Error('temporary需要布尔值，仅标记实际临时资料')
    if (item.temporary && item.category !== undefined && !['temporary', 'cleanup', 'research'].includes(item.category)) throw new Error('临时资料category支持temporary、cleanup、research')
  }
  for (const other of project[name]) if (other !== old && ((data.supersedes ?? []).includes(other.id) || kind === 'requirement' && data.key && other.key === data.key && other.status === 'active')) {
    other.status = 'superseded'; other.revision++
  }
  if (old) project[name][project[name].indexOf(old)] = item
  else project[name].push(item)
  await save(root, project)
  return item
}

/**
 * 批次复盘校准：审阅通过后，把后续细纲/伏笔/事实的调整登记下来。
 * 只有登记过本轮校准，doctor 才允许开下一批。
 */
export async function prepareCalibration(root, project, data, proposedPaths = []) {
  if (!data.note?.trim()) throw new Error('校准需要 note：说明细纲、伏笔与事实怎么调整')
  if (project.scope.mode === 'pause') throw new Error('当前已暂停，不登记新的制作校准')
  let item
  if (data.chapters) {
    if (!Array.isArray(data.chapters) || !data.chapters.length || !data.source) throw new Error('恢复返修需要 chapters 和作者新决定 source')
    const chapters = [...new Set(data.chapters.map(n => integer(n)))]
    if (chapters.some(n => n < project.scope.from || n > project.scope.to)) throw new Error('恢复章号超出当前授权')
    item = { kind: 'repair-reset', chapters, reviewCount: project.reviews.length }
  } else {
    const target = calibrationTarget(project)
    if (!target || data.review && data.review !== target.review) throw new Error('没有匹配当前授权的待校准批次')
    if (!Array.isArray(data.outline) || data.outline.length === 0) throw new Error('校准需要 outline：列出本次核对或更新过的细纲章号')
    const outline = [...new Set(data.outline.map(n => integer(n, '细纲章号')))]
    if (outline.some(n => n < target.from || n > target.to) || outline.length !== target.to - target.from + 1) throw new Error('校准细纲必须覆盖当前待校准范围，不能遗漏或越界')
    for (const id of outline) {
      const full = await existingOutline(root, project, id)
      const path = await managedPath(root, dirname(full), basename(full))
      if (!existsSync(path) && !proposedPaths.includes(path)) throw new Error(`第${pad(id)}章细纲不存在，先实际核对或更新后登记校准`)
    }
    item = { kind: 'batch', ...target, outline }
  }
  item = { id: `CAL${project.calibrations.length + 1}`, ...item, scopeRevision: project.scope.revision,
    note: data.note.trim(), source: data.source ?? null, time: new Date().toISOString() }
  return item
}
export async function calibrate(root, project, data) {
  const item = await prepareCalibration(root, project, data)
  project.calibrations.push(item)
  await save(root, project)
  return item
}
