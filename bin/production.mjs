import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { local, portable, pad, integer, optional, textFile, stamp, optionalStamp, sameStamp, save, discover, scan, registerFiles,
  chapterIds, latest, nextChapter, contract, relevant, lengthInfo, measure, chapterText, sourceSlices, versionValid, evidence,
  missingParameters, calibrationTarget, repairStreaks, outlineContext, existingOutline, issueBlocks, issueRange, rowVerdict } from './project.mjs'
import { requireJob } from './tasks.mjs'
import { safePath, managedPath } from './paths.mjs'
import * as D from './documents.mjs'

export const dimensions = project => ['符合要求', '剧情逻辑', '文字质量', ...(project.mode === '改编精修' ? ['改编符合性', '删改合理性', '文风一致性'] : [])]
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const inScope = (project, chapter) => chapter >= project.scope.from && chapter <= project.scope.to
export function openIssues(project, chapter) {
  return project.issues.filter(x => x.status === 'open' && (chapter === undefined || x.from <= chapter && x.to >= chapter))
}
function latestIssueReview(project, chapter, issue) {
  const first = project.reviews.findIndex(review => review.id === issue.review)
  for (let i = project.reviews.length - 1; i >= 0; i--) {
    const review = project.reviews[i], row = review.chapters.find(item => item.chapter === chapter)
    if (!row) continue
    // 旧账从问题提出后逐章取观察记录；局部复核不能覆盖其他章的基线。
    if (first >= 0 && i >= first || review.id === issue.reviewedBy || review.resolutions?.some(item => item.id === issue.id)) return { review, row }
  }
  return null
}
function awaitingVerification(project, chapter, issue) {
  const version = latest(project, chapter)
  const reviewed = latestIssueReview(project, chapter, issue)?.row.version ??
    project.chapters[chapter]?.versions.find(item => item.path === issue.evidence?.path)?.version
  return version?.receipt && reviewed !== undefined && version.version > reviewed
}
export async function approvals(root, project, options = {}) {
  const approved = new Map(), invalid = []
  const contracts = new Map(), outlineCache = options.outlineCache ?? new Map()
  const verdicts = new Map()
  for (const review of project.reviews) for (const row of review.chapters) verdicts.set(`${row.chapter}:${row.version}`, rowVerdict(review, row))
  for (const review of project.reviews) {
    for (const row of review.chapters) {
      if (rowVerdict(review, row) !== 'passed') continue
      if (verdicts.get(`${row.chapter}:${row.version}`) !== 'passed') continue
      const version = project.chapters[row.chapter]?.versions.find(v => v.version === row.version)
      if (!contracts.has(row.chapter)) contracts.set(row.chapter, await contract(root, project, row.chapter, { outlineCache }))
      const valid = version && sameStamp(version.stamp, row.stamp) && await versionValid(root, version) &&
        same(row.contract, contracts.get(row.chapter)) && !openIssues(project, row.chapter).some(issueBlocks)
      if (!valid) { invalid.push({ review: review.id, chapter: row.chapter }); continue }
      if (!approved.has(row.chapter) || row.version > approved.get(row.chapter).version) approved.set(row.chapter, { ...version, review: review.id })
    }
  }
  return { approved, invalid }
}
export async function dueBatch(root, project, approved, options = {}) {
  const ids = chapterIds(project).filter(id => inScope(project, id))
  const outlineCache = options.outlineCache ?? new Map()
  const reviewed = new Set()
  if (project.scope.mode === 'review') for (const review of project.reviews) for (const row of review.chapters) {
    const current = latest(project, row.chapter)
    if (current?.version === row.version && await versionValid(root, current) && same(row.contract, await contract(root, project, row.chapter, { outlineCache })) &&
      openIssues(project, row.chapter).every(issue => latestIssueReview(project, row.chapter, issue)?.review.id === review.id)) reviewed.add(row.chapter)
  }
  for (let from = project.scope.from; from <= project.scope.to; from += project.interval) {
    const to = Math.min(from + project.interval - 1, project.scope.to)
    const written = ids.filter(id => id >= from && id <= to)
    const pending = written.filter(id => project.scope.mode === 'review' ? !reviewed.has(id) : approved.get(id)?.version !== latest(project, id).version)
    const verificationDue = pending.some(id => openIssues(project, id).some(issue => issueBlocks(issue) && awaitingVerification(project, id, issue)))
    if (pending.length && (written.length === to - from + 1 || project.scope.mode !== 'continue' || verificationDue)) {
      const chapters = new Set(pending)
      if (project.scope.mode !== 'review') {
        let expanded
        do {
          expanded = false
          for (const issue of openIssues(project).filter(issueBlocks)) {
            if (issue.from < project.scope.from || issue.to > project.scope.to || ![...chapters].some(id => id >= issue.from && id <= issue.to)) continue
            const affected = ids.filter(id => id >= issue.from && id <= issue.to)
            if (affected.length !== issue.to - issue.from + 1) continue
            for (const id of affected) if (!chapters.has(id)) { chapters.add(id); expanded = true }
          }
        } while (expanded)
      }
      const ordered = [...chapters].sort((a, b) => a - b)
      return { from: Math.min(from, ordered[0]), to: Math.max(to, ordered.at(-1)), chapters: ordered }
    }
    if (written.length < to - from + 1) break
  }
  return null
}
export async function diagnose(root, project = null) {
  const result = await diagnoseState(root, project)
  if (project) {
    result.plan = { start: project.start, end: project.end, positions: project.end - project.start + 1 }
    result.lengthPolicy = { ...project.length, ...(project.length.type === 'fixed' ? { words: project.words } : {}) }
  }
  const call = action => {
    if (action.type === 'archive') return { action: 'archive' }
    if (action.type === 'reconcile') return { action: 'doctor', options: { fix: true } }
    if (action.type === 'finish') return { action: 'dispatch', options: { role: '文笔', action: 'finish', chapters: action.chapters.slice(0, project.interval) } }
    if (['write', 'repair', 'repair-length', 'repair-format'].includes(action.type)) return { action: 'dispatch', options: { role: '文笔', action: action.type, chapter: action.chapters[0] } }
    if (action.type === 'review') return { action: 'dispatch', options: { role: '复核', action: 'review', chapters: action.chapters } }
    if (action.type === 'plan') return { action: 'dispatch', options: { role: '主编', action: 'plan' } }
    if (action.type === 'outline') return { action: 'dispatch', options: { role: '剧情', action: 'outline', chapter: action.chapters[0] } }
    if (action.type === 'calibrate') return { action: 'dispatch', options: { role: '剧情', action: 'calibrate', from: action.from, to: action.to, review: action.review } }
    if (action.type === 'capture-requirements') return { action: 'dispatch', options: { role: '主编', action: 'capture-requirements' } }
    if (action.type === 'select-document') return { action: 'documents', options: { kind: 'chapters', offset: 0, limit: 10 } }
    return null
  }
  for (const action of new Set([...(result.tasks ?? []), result.nextAction].filter(Boolean))) {
    const next = call(action)
    if (next) action.call = next
  }
  return result
}
export function inspectReport(report) {
  const diagnostic = item => { const { call, ...value } = item; return value }
  return { ...report, inspection: true, productionStage: report.stage, stage: 'inspect',
    diagnostics: [...(report.diagnostics ?? []), ...(report.tasks ?? [])].map(diagnostic), tasks: [],
    nextAction: { type: 'inspect-complete', requiresUser: false,
      reason: '本次仅查看资料与确认进度；汇报实际状态及待办，不修改登记、不派制作或finish任务，不恢复旧授权中的未完成工作' } }
}
async function diagnoseState(root, project = null) {
  if (!project) {
    const found = await discover(root)
    const existing = found.candidates.length > 0 || found.hasPlanningDocuments
    return { stage: existing ? 'existing-project' : 'new-project', discovery: found,
      nextAction: { type: existing ? 'import' : 'plan', requiresUser: false,
        reason: existing ? '读取并复用已有文档；即使尚无正文也可import接手，参数依据另行核实，不重建立项文件' : '从用户已有信息建立立项，只询问影响全书方向的缺失信息' } }
  }
  const outlineCache = new Map()
  const ids = chapterIds(project), next = nextChapter(project)
  let approvalState
  try { approvalState = await approvals(root, project, { outlineCache }) } catch (error) {
    if (error.code !== 'DOCUMENT_CHOICE') throw error
    const action = { type: 'select-document', chapter: error.chapter, candidates: error.candidates, requiresUser: false, reason: error.message }
    return { title: project.title, scope: project.scope, stage: project.scope.mode === 'pause' ? 'paused' : action.type,
      diagnostics: project.scope.mode === 'pause' ? [action] : [], tasks: project.scope.mode === 'pause' ? [] : [action],
      nextAction: project.scope.mode === 'pause' ? { type: 'paused', requiresUser: false, reason: '保持暂停，文档候选留作接续分析' } : action }
  }
  const { approved, invalid } = approvalState
  const scopedIds = ids.filter(id => inScope(project, id)), lastReview = project.reviews.at(-1)
  const progress = { currentChapterCount: scopedIds.length,
    currentChapters: scopedIds.slice(-10).map(chapter => {
      const version = latest(project, chapter)
      return { chapter, version: version.version, path: version.path, words: version.words, receipt: Boolean(version.receipt),
        approved: approved.get(chapter)?.version === version.version }
    }), latestReview: lastReview ? { id: lastReview.id, verdict: lastReview.verdict,
      path: `${project.paths.reports}/${lastReview.id}.md`, chapterCount: lastReview.chapters.length,
      chapters: lastReview.chapters.slice(-10).map(({ chapter, version }) => ({ chapter, version })),
      current: lastReview.chapters.every(row => row.version === latest(project, row.chapter)?.version && approved.get(row.chapter)?.version === row.version) } : null }
  const documents = D.summary(await D.inventory(root, project, { cache: outlineCache })).targets
  const diagnostics = [], tasks = []
  const dependents = new Map()
  for (let chapter = project.scope.from; chapter <= project.scope.to; chapter++) {
    for (const dependency of new Set([chapter - 1, ...(project.chapters[chapter]?.dependencies ?? [])])) {
      if (dependency < project.start || dependency >= chapter) continue
      if (!dependents.has(dependency)) dependents.set(dependency, new Set())
      dependents.get(dependency).add(chapter)
    }
  }
  const chapterTask = task => {
    const affectedChapters = [...new Set(task.chapters.flatMap(chapter => [...(dependents.get(chapter) ?? [])]))]
    if (task.chapters.some(chapter => inScope(project, chapter)) || affectedChapters.length) tasks.push({ ...task, ...(affectedChapters.length ? { affectedChapters } : {}) })
    else diagnostics.push({ ...task, historical: true, reason: `${task.reason}；授权范围外且不影响本轮依赖，保留待核对，不阻塞当前目标` })
  }
  const files = await scan(root, project.paths.body, project)
  for (const material of project.materials.filter(x => x.status === 'active')) if (!existsSync(local(root, material.path))) {
    const relevant = material.to >= project.scope.from && material.from <= project.scope.to
    ;(relevant ? tasks : diagnostics).push({ type: 'repair-reference', records: [material.id], requiresUser: false, ...(!relevant ? { historical: true } : {}), reason: '资料引用失效，查找实际新位置后更新登记或记录停用，不伪造已读' })
  }
  const untracked = files.filter(row => !project.chapters[row.chapter]?.versions.some(v => v.path === row.path && v.version === row.version))
  for (const scoped of [true, false]) {
    const chapters = [...new Set(untracked.filter(row => (inScope(project, row.chapter) || dependents.has(row.chapter)) === scoped).map(row => row.chapter))]
    if (chapters.length) chapterTask({ type: 'reconcile', chapters, requiresUser: false, reason: '发现未登记章稿，先 doctor --fix 登记，不能推断已经验收' })
  }
  for (const id of ids) {
    const version = latest(project, id)
    const relevant = inScope(project, id) || dependents.has(id)
    const valid = relevant ? await versionValid(root, version) : sameStamp(version.stamp, await optionalStamp(local(root, version.path)))
    if (!valid) chapterTask({ type: 'repair-record', chapters: [id], requiresUser: false, reason: '章稿被外部修改或缺失，核对采用版并复验，不覆盖旧记录或擅改未授权章节' })
    else if (inScope(project, id)) {
      try { await existingOutline(root, project, id, { outlineCache }) } catch (error) {
        if (error.code !== 'DOCUMENT_CHOICE') throw error
        tasks.push({ type: 'select-document', chapters: [id], candidates: error.candidates, requiresUser: false, reason: error.message })
      }
      const text = await textFile(local(root, version.path))
      const length = lengthInfo(project, id, version.words)
      if (length.verdict === '红') (project.scope.mode === 'review' ? diagnostics : tasks).push({ type: 'repair-length', chapters: [id], requiresUser: false, reason: '篇幅超出当前明确配置，按实际场景补修，不重复解释凑数', length })
      const dirty = text.split(/\r?\n/).find(line => /^(?:<{7}|={7}|>{7}|\+(?:　|\s{2,}))/.test(line))
      if (dirty) (project.scope.mode === 'review' ? diagnostics : tasks).push({ type: 'repair-format', chapters: [id], requiresUser: false, reason: '正文发现合并或补丁残留，核对原句后在授权内保存修订版', evidence: { path: version.path, quote: dirty } })
    }
  }
  if (project.source) {
    const current = await optionalStamp(local(root, project.source.path))
    if (!current) tasks.unshift({ type: 'restore-source', path: local(root, project.source.path), requiresUser: false, reason: '底本文件缺失，查找实际位置后用 source 更新；找不到时合并询问，恢复前停止制作与交付' })
    else if (!sameStamp(project.source.stamp, current)) tasks.push({ type: 'reindex-source', requiresUser: false, reason: '底本发生变化，重建章节索引并核对受影响映射' })
  }
  const scope = project.scope
  const missing = missingParameters(project)
  if (scope.mode === 'pause' && (scope.revision > 0 || !missing.length)) return { stage: 'paused', title: project.title, written: ids.length, nextChapter: next,
    scope, documents, ...progress, diagnostics: [...tasks, ...diagnostics], nextAction: { type: 'paused', requiresUser: false, reason: '当前授权为暂停；保留接续状态，等待明确的新任务' } }
  if (missing.length) tasks.unshift({ type: 'configure', missing: missing.map(x => x.key), questions: missing.map(x => x.question), requiresUser: true,
    reason: '先从用户已有指示和现行文档查明这些参数及来源，仅对仍缺失的项目一次询问；登记来源后不重复询问，默认值不算用户规定' })
  if (project.mode === '改编精修' && !project.source) tasks.push({ type: 'index-source', requiresUser: false, reason: '从现有资料选择当前正式底本并建立索引，避免用统一章均替代原章篇幅' })
  for (const item of [...project.facts, ...project.requirements].filter(x => x.status === 'active' && x.to >= scope.from && x.from <= scope.to && x.evidence?.path)) {
    if (!existsSync(local(root, item.evidence.path)) || !sameStamp(item.evidence.stamp, await stamp(local(root, item.evidence.path)))) tasks.push({ type: 'refresh-evidence', records: [item.id], requiresUser: false, reason: '事实依据文件已变化，回查并更新记录，不沿用旧证据' })
  }
  const issues = project.issues.filter(x => x.status === 'open' && x.to >= scope.from && x.from <= scope.to)
  const unresolved = issues.filter(x => x.requiresUser)
  if (unresolved.length && scope.mode !== 'review') tasks.push({ type: 'decision', issues: unresolved.map(x => x.id), requiresUser: true, reason: '合并这些无法从现有证据判断的作者取舍，并给出推荐方案，一次询问' })
  const outsideScope = issues.filter(issue => issueBlocks(issue) && (issue.from < scope.from || issue.to > scope.to))
  if (outsideScope.length && scope.mode !== 'review') tasks.push({ type: 'review-scope', issues: outsideScope.map(issue => issue.id),
    ranges: outsideScope.map(({ id, from, to }) => ({ id, from, to })), requiresUser: true,
    reason: '阻塞问题的完整影响范围超出当前授权，局部复核不能关闭；先请作者确认覆盖这些范围的复核/修订授权，不自动越界或重复局部复核' })
  if (scope.mode === 'review') diagnostics.push(...issues.map(x => ({ type: 'reported-issue', id: x.id, requiresUser: x.requiresUser, status: x.status })))
  const rounds = project.maxRepairRounds ?? 3
  const tripped = repairStreaks(project).filter(chapter => {
    const row = [...project.reviews].reverse().find(review => review.chapters.some(row => row.chapter === chapter))?.chapters.find(row => row.chapter === chapter)
    const version = latest(project, chapter)
    return !version?.receipt || !row || version.version <= row.version
  })
  if (tripped.length && scope.mode !== 'review') tasks.push({ type: 'circuit-break', chapters: tripped, rounds, requiresUser: true,
    reason: `第${tripped.map(pad).join('、')}章连续 ${rounds} 次复审未通过：熔断，暂停返修，先请用户校准目标、细纲或篇幅策略` })
  const pendingExceptions = project.exceptions.filter(x => x.status === 'pending' && x.to >= scope.from && x.from <= scope.to)
  if (pendingExceptions.length && scope.mode !== 'review') tasks.push({ type: 'exception-decision', exceptions: pendingExceptions.map(x => x.id), requiresUser: true,
    reason: '破格申请待裁决：逐条给出代价、影响范围与推荐选项，用户确认后记录 approved / rejected 与依据' })
  const repairs = issues.filter(x => !x.requiresUser && issueBlocks(x))
  if (repairs.length && scope.mode !== 'review') tasks.push({ type: 'repair', chapters: [...new Set(repairs.flatMap(x => Array.from({ length: x.to - x.from + 1 }, (_, i) => x.from + i)))],
    issues: repairs.map(x => x.id), requiresUser: false, reason: '在已授权范围内自行返修明确问题，完成后局部复验' })
  for (const task of tasks.filter(x => x.type === 'repair')) {
    task.chapters = task.chapters.filter(id => inScope(project, id) && repairs.some(issue => issue.from <= id && issue.to >= id && !awaitingVerification(project, id, issue)))
    task.issues = repairs.filter(issue => task.chapters.some(id => issue.from <= id && issue.to >= id)).map(issue => issue.id)
    if (!task.chapters.length) tasks.splice(tasks.indexOf(task), 1)
  }
  for (const gate of [0, 1, 2, 3]) if (!project.gates[gate]?.passed) {
    tasks.push({ type: 'plan', gate, documents, requiresUser: false, reason: `先读取并分析已有 G${gate} 对应资料，复用可用成果；仅补实际缺口，不因默认文件名不存在重建文档` }); break
  }
  if (project.mode === '改编精修' && !project.requirements.some(x => x.status === 'active')) tasks.push({ type: 'capture-requirements', requiresUser: false, reason: '从现行要求、目标变更与计划中提取有效要求，保留来源和替代关系；不把执行者自述当用户批准' })
  const unfinished = ids.filter(id => inScope(project, id) && !latest(project, id).receipt)
  if (unfinished.length) tasks.push({ type: 'finish', chapters: unfinished, requiresUser: false, reason: '按审查间隔批量读回这些章的当前正文，只补两更和出章状态；不重写或顺带修稿，补登记不等于复核通过' })
  if (tasks.some(task => task.type === 'select-document')) return { title: project.title, scope, documents, ...progress,
    stage: tasks[0].type, diagnostics, tasks, nextAction: tasks[0] }
  const batch = await dueBatch(root, project, approved, { outlineCache })
  if (batch) tasks.push({ type: 'review', ...batch, requiresUser: false, reason: '本批已到复审节点；本轮末尾不足整批也审阅，不补写授权终点以外章节' })
  const calibration = calibrationTarget(project, approved)
  if (calibration && !tasks.some(task => ['finish', 'review', 'repair', 'repair-length', 'repair-format'].includes(task.type))) tasks.push({ type: 'calibrate', ...calibration, requiresUser: false,
    reason: '上一批已通过：先核对并更新当前授权内后续细纲、伏笔与事实，用 calibrate 登记复盘结论再开下一批' })
  if (scope.mode === 'continue' && next <= scope.to) {
    const chapter = Math.max(next, scope.from)
    if (chapter !== next) tasks.push({ type: 'resolve-gap', chapters: [next], requiresUser: true, reason: '当前授权起点之前存在缺章，需确认补写范围' })
    else if (project.length.type === 'source' && !project.chapters[chapter]?.sourceIds?.length && !project.source?.chapters[chapter] && project.chapters[chapter]?.treatment !== '新增') {
      tasks.push({ type: 'map-source', chapters: [chapter], requiresUser: false, reason: '先对照底本建立本章保留、合并、删除或新增映射' })
    } else {
      try {
        const outline = await existingOutline(root, project, chapter, { outlineCache })
        tasks.push({ type: existsSync(outline) ? 'write' : 'outline', chapters: [chapter], requiresUser: false, reason: existsSync(outline) ? '复用本章已有细纲，制作下一章' : '先核对现有章节规划，确实缺失时细化本章后继续' })
      } catch (error) {
        if (error.code !== 'DOCUMENT_CHOICE') throw error
        tasks.push({ type: 'select-document', chapters: [chapter], candidates: error.candidates, requiresUser: false, reason: error.message })
      }
    }
  }
  const full = ids.length === project.end - project.start + 1 && next > project.end
  if (!tasks.length && (scope.mode === 'export' || scope.deliver)) {
    if (full && !await finalApproved(root, project)) tasks.push({ type: 'final-review', requiresUser: false, reason: '全书已写齐，完成全书质量复核后正式交付' })
    else {
      const edition = full ? 'final' : 'partial', from = full ? project.start : scope.from, to = full ? project.end : Math.min(scope.to, ids.at(-1) ?? scope.from)
      const formats = scope.formats ?? ['md', 'txt', 'docx', 'epub']
      if (!project.exports.some(x => x.artifact === 'adaptation' && x.projectContent === contentKey(project) && x.edition === edition &&
        x.range[0] === from && x.range[1] === to && formats.every(ext => x.files.some(path => path.endsWith('.' + ext) && existsSync(local(root, path)))))) {
        tasks.push({ type: 'export', artifact: 'adaptation', edition, from, to, formats, requiresUser: false, reason: '按本轮交付要求自动导出并登记实际文件；原作或分析汇编不抵扣改编交付' })
      }
    }
  }
  let nextAction = tasks[0] ?? { type: 'complete', requiresUser: false, reason: '当前授权范围制作与复核完成，保存交接并简报成果' }
  if (nextAction.type === 'complete' && project.autoArchive !== false && project.cleanupScope !== scope.revision) {
    nextAction = { type: 'archive', requiresUser: false, reason: '当前目标已完成，自动分类归档过程资料后结束；正式文件与当前引用保留原位' }
  }
  const active = (project.jobs ?? []).filter(x => ['pending', 'running'].includes(x.status) && x.scopeRevision === scope.revision)
  if (active.length && !tasks.some(x => x.requiresUser)) nextAction = { type: 'collect', jobs: active.map(x => ({ id: x.id, role: x.role, agent: x.agent, status: x.status,
    result: local(root, `${x.directory}/result.json`) })), requiresUser: false, reason: '继续或等待已有子代理任务并收集结果；不要重复派发或在队长上下文代写' }
  return { title: project.title, stage: nextAction.type, written: ids.length, planned: project.end - project.start + 1,
    nextChapter: next, latestApproved: ids.filter(id => approved.get(id)?.version === latest(project, id).version).length,
    scope, documents, ...progress, archive: project.archives?.at(-1) ? { index: project.archives.at(-1).index, files: project.archives.at(-1).files } : null,
    invalidReviews: invalid, diagnostics, tasks, nextAction }
}
export function contentKey(project) {
  return JSON.stringify({ chapters: chapterIds(project).map(id => [id, latest(project, id).version]),
    requirements: project.requirements.map(x => [x.id, x.revision, x.status]), facts: project.facts.map(x => [x.id, x.revision, x.status]), metadata: project.metadata })
}
export async function finalApproved(root, project) {
  const record = project.reviews.filter(r => r.kind === 'final' && r.verdict === 'passed').at(-1)
  if (!record || record.chapters.length !== project.end - project.start + 1) return false
  const { approved } = await approvals(root, project)
  for (const row of record.chapters) {
    if (latest(project, row.chapter)?.version !== row.version || approved.get(row.chapter)?.version !== row.version || !same(row.contract, await contract(root, project, row.chapter))) return false
  }
  return !openIssues(project).some(issueBlocks)
}
export async function context(root, project, chapter, options = {}) {
  chapter = integer(chapter)
  options = { ...options, outlineCache: options.outlineCache ?? new Map() }
  const row = project.chapters[chapter], version = latest(project, chapter)
  const previous = latest(project, chapter - 1)
  const previousText = previous ? await textFile(local(root, previous.path)) : ''
  // 只摘取段首时间转场原句供定位，不解释时间关系，也不代替必要的回查。
  const timeTransitions = previousText.split(/\r?\n/).flatMap((line, index) =>
    /^(?:第[\d一二三四五六七八九十百零〇两]+天|[次翌]日|翌晨|[\d一二三四五六七八九十百零〇两]+[天日]后|当天|当晚|当夜)/u.test(line.trimStart())
      ? [{ line: index + 1, quote: line.trim().slice(0, 700), excerpt: true }] : []).slice(-3)
  const sourceIds = row?.sourceIds ?? (project.source?.chapters[chapter] ? [chapter] : [])
  const outlines = await outlineContext(root, project, chapter, options)
  const documents = await D.inventory(root, project, { cache: options.outlineCache })
  const lessons = new Map()
  for (const item of project.experiences.filter(x => x.status === 'active' && x.from <= chapter && x.to >= chapter)) {
    lessons.set(item.id.match(/^E_(\d+)_\d+$/)?.[1] ?? item.id, item)
  }
  const dependencies = await contract(root, project, chapter, { outlineContext: outlines })
  if (project.length.type === 'source') {
    // 保留内部历史审阅契约的形状，仅去掉给模型看的无效固定字数占位。
    const { words, ...policy } = dependencies.lengthPolicy
    dependencies.lengthPolicy = policy
  }
  return { chapter, nextVersion: (version?.version ?? 0) + 1,
    target: local(root, `${project.paths.body}/第${pad(chapter)}章-v${(version?.version ?? 0) + 1}.md`),
    scope: project.scope, ...outlines,
    source: project.source && await optionalStamp(local(root, project.source.path)) ? await sourceSlices(root, project, sourceIds, options.sourceLines) : [], length: lengthInfo(project, chapter, version?.words ?? 0),
    requirements: relevant(project, 'requirements', chapter), facts: relevant(project, 'facts', chapter),
    exceptions: (project.exceptions ?? []).filter(x => x.status === 'approved' && x.from <= chapter && x.to >= chapter),
    dueForeshadowing: project.facts.filter(x => x.status === 'active' && x.type === 'foreshadowing' && x.dueAt <= chapter && x.state !== 'closed'),
    issues: openIssues(project, chapter),
    resolvedIssues: project.issues.filter(issue => issue.status === 'resolved' && issue.from <= chapter && issue.to >= chapter)
      .map(({ id, text, resolution, evidence }) => ({ id, text, resolution, evidence })),
    entryState: row?.entryState ?? project.chapters[chapter - 1]?.exitState ?? null,
    previous: previous ? { path: local(root, previous.path), tail: previousText.slice(-2500), timeTransitions,
      readingNote: '时间转场为前章段首原句摘录，尾段不是全章；回指中段事件时对照这些位置，必要时按path和line读相关上下文，不把摘录当自动时间判定。' } : null,
    experience: [...lessons.values()].slice(-8),
    readingPaths: [...new Set([local(root, project.paths.notes), local(root, project.paths.experience),
      ...['style', 'world', 'characters', 'synopsis'].map(kind => documents.targets[kind]).filter(item => item.exists).map(item => local(root, item.path)),
      ...project.materials.filter(x => x.status === 'active' && x.kind === 'analysis' && x.from <= chapter && x.to >= chapter).map(x => local(root, x.path))])],
    dependencies, diagnosis: options.diagnosis === false ? undefined : (options.report ?? await diagnose(root, project)).nextAction }
}
export async function assertWriteReady(root, project, chapter, report = null) {
  report ??= await diagnose(root, project)
  const blocker = (report.tasks ?? []).find(x => x.requiresUser || ['restore-source', 'reindex-source', 'index-source', 'refresh-evidence'].includes(x.type) ||
    ['reconcile', 'repair-record'].includes(x.type) && (x.chapters.includes(chapter) || x.affectedChapters?.includes(chapter)) || x.type === 'calibrate' && chapter >= x.from)
  if (blocker) throw new Error(`先处理 ${blocker.type}：${blocker.reason}`)
  return report
}
export async function writeChapter(root, project, chapter, text, allowRevision = false, taskId = null) {
  chapter = integer(chapter)
  const scope = project.scope, current = latest(project, chapter)
  if (!['continue', 'revise'].includes(scope.mode) || !inScope(project, chapter)) throw new Error('正文修改不在当前有效授权范围内')
  const job = requireJob(project, taskId, '文笔', chapter, ['write', 'repair', 'repair-length', 'repair-format'])
  const report = await assertWriteReady(root, project, chapter)
  if ([0, 1, 2, 3].some(g => !project.gates[g]?.passed)) throw new Error('G0—G3 尚未通过')
  const packet = await context(root, project, chapter, { report })
  if (!packet.outline.text?.trim()) throw new Error('本章缺少细纲')
  if (!text.trim()) throw new Error('草稿为空')
  if (!current && chapter !== nextChapter(project)) throw new Error(`请先处理第${pad(nextChapter(project))}章`)
  if (!current) {
    if (openIssues(project).some(x => x.severity === 'red' && x.from < chapter && x.to >= scope.from)) throw new Error('先处理授权范围内阻塞后续的红项')
    const unfinished = chapterIds(project).filter(id => inScope(project, id) && id < chapter && !latest(project, id).receipt)
    if (unfinished.length) throw new Error(`前章尚未两更：${unfinished.join('、')}`)
    const { approved } = await approvals(root, project)
    if (await dueBatch(root, project, approved)) throw new Error('先完成到期批次复审，再写新章')
  }
  const { approved } = await approvals(root, project)
  if (approved.has(chapter) && !(allowRevision || scope.reviseApproved)) throw new Error('本章已有通过版本，需要已有用户授权对应的 reviseApproved 或 --revise-approved')
  if (project.length.type === 'source' && !packet.source.length && project.chapters[chapter]?.treatment !== '新增') throw new Error('改编章节缺少底本映射')
  await managedPath(root, project.paths.body, packet.target)
  const path = portable(root, packet.target)
  await mkdir(dirname(packet.target), { recursive: true })
  await writeFile(packet.target, text, { flag: 'wx', encoding: 'utf8' })
  const row = project.chapters[chapter] ??= { sourceIds: packet.source.map(x => x.chapter).filter((v, i, a) => a.indexOf(v) === i), treatment: project.mode === '原创' ? '新增' : '改写', baselineTreatment: project.mode === '原创' ? '新增' : '改写', dependencies: [], factIds: [], entities: [], versions: [] }
  row.versions.push({ version: packet.nextVersion, path, stamp: await stamp(packet.target), words: measure(text), title: chapterText(text, `第${pad(chapter)}章`).title, receipt: null, task: job.id, authorAgent: job.agent })
  project.checkpoint = { time: new Date().toISOString(), chapter, version: packet.nextVersion, nextAction: 'finish', scopeRevision: scope.revision }
  await save(root, project)
  return { path: packet.target, version: packet.nextVersion, length: lengthInfo(project, chapter, measure(text)) }
}
async function appendReceipt(root, path, marker, body) {
  const full = local(root, path)
  await managedPath(root, dirname(full), full)
  const current = await optional(full) ?? ''
  const begin = `<!-- ${marker} -->`, end = `<!-- /${marker} -->`, block = `${begin}\n${body}\n${end}`
  let updated
  if (current.includes(begin)) {
    const from = current.indexOf(begin), to = current.indexOf(end, from)
    if (to < 0) throw new Error(`两更标记未闭合：${path}`)
    updated = current.slice(0, from) + block + current.slice(to + end.length)
  } else updated = current.trimEnd() + '\n\n' + block + '\n'
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, updated, 'utf8')
}
export async function finish(root, project, data, taskId = null, report = null) {
  const chapter = integer(data.chapter), version = latest(project, chapter)
  if (!version || !await versionValid(root, version)) throw new Error('章稿缺失或已被外部改动，先核对版本')
  if (!inScope(project, chapter) || !['continue', 'revise'].includes(project.scope.mode)) throw new Error('两更范围不在当前制作授权内；只读审阅不补写两更')
  const job = requireJob(project, taskId, '文笔', chapter, ['write', 'repair', 'repair-length', 'repair-format', 'finish'])
  if (job.action === 'finish') await assertWriteReady(root, project, chapter, report)
  validateReceipt(data, { metadataOnly: job.action === 'finish' })
  const row = project.chapters[chapter]
  row.exitState = data.exitState
  if (data.entities) row.entities = [...new Set([...(row.entities ?? []), ...data.entities])]
  if (data.factIds) row.factIds = [...new Set([...(row.factIds ?? []), ...data.factIds])]
  const marker = `novel:${chapter}:v${version.version}`
  const notesPath = local(root, project.paths.notes), experiencePath = local(root, project.paths.experience)
  if (process.platform === 'win32' ? notesPath.toLowerCase() === experiencePath.toLowerCase() : notesPath === experiencePath) {
    await appendReceipt(root, project.paths.notes, marker, `## 第${pad(chapter)}章 v${version.version}\n\n### 注意事项\n${data.notes}\n\n出章状态：${JSON.stringify(data.exitState)}\n\n### 经验\n${data.experience}`)
  } else {
    await appendReceipt(root, project.paths.notes, marker, `## 第${pad(chapter)}章 v${version.version}\n\n${data.notes}\n\n出章状态：${JSON.stringify(data.exitState)}`)
    await appendReceipt(root, project.paths.experience, marker, `## 第${pad(chapter)}章 v${version.version}\n\n${data.experience}`)
  }
  version.receipt = { time: new Date().toISOString(), notes: data.notes, experience: data.experience, contract: await contract(root, project, chapter) }
  const lessonId = `E_${chapter}_${version.version}`, oldLesson = project.experiences.find(x => x.id === lessonId)
  const lesson = { id: lessonId, revision: (oldLesson?.revision ?? 0) + 1, status: 'active', from: chapter, to: project.end,
    text: data.experience, source: version.path, history: [] }
  if (oldLesson) project.experiences[project.experiences.indexOf(oldLesson)] = lesson
  else project.experiences.push(lesson)
  project.checkpoint = { time: version.receipt.time, chapter, version: version.version, exitState: data.exitState, scopeRevision: project.scope.revision, nextAction: 'doctor' }
  await save(root, project)
  return version.receipt
}
export function validateReceipt(data, { metadataOnly = false } = {}) {
  if (metadataOnly && ['text', 'draftFile', 'patches', 'format', 'rewriteReason'].some(key => Object.hasOwn(data, key))) throw new Error('finish只补现稿两更和出章状态，不接收text、draftFile、patches或format；正文改动须另派repair，不能静默忽略补丁')
  if (typeof data.notes !== 'string' || !data.notes.trim() || typeof data.experience !== 'string' || !data.experience.trim() || !data.exitState) throw new Error('finish 需要 notes、experience 和 exitState')
  for (const key of ['entities', 'factIds']) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(value => typeof value !== 'string' || !value.trim()))) throw new Error(`${key} 必须是非空字符串数组`)
}
export async function reviewDraft(root, project, ids, kind = 'batch', options = {}) {
  const rows = [], outlineCache = options.outlineCache ?? new Map()
  for (const chapter of ids) {
    const version = latest(project, chapter)
    if (!version) throw new Error(`第${pad(chapter)}章尚未落盘`)
    rows.push({ chapter, version: version.version, path: version.path, stamp: version.stamp,
      contract: await contract(root, project, chapter, { outlineCache }), length: lengthInfo(project, chapter, version.words),
      verdict: 'pending', outlineComplete: false, requirementsMet: false, logicChecked: false, styleChecked: false, lengthReason: '', evidence: [] })
  }
  if (kind === 'final' && (rows.length !== project.end - project.start + 1 || nextChapter(project) <= project.end)) throw new Error('全书未完整，不能创建最终验收')
  const data = { kind, verdict: 'pending', chapters: rows, grades: Object.fromEntries(dimensions(project).map(key => [key, { grade: '', reason: '' }])), issues: [],
    resolutions: openIssues(project).filter(issue => ids.some(id => issue.from <= id && issue.to >= id)).map(issue => ({ id: issue.id, status: 'open', resolution: '', evidence: null })), summary: '' }
  const dir = await safePath(root, '.novel-workshop/review-drafts')
  await mkdir(dir, { recursive: true })
  let n = 1, path
  do { path = join(dir, `${kind}-${pad(ids[0])}-${pad(ids.at(-1))}-v${n++}.json`) } while (existsSync(path))
  await safePath(root, path)
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
  return { path, data }
}
async function reviewFieldErrors(root, project, data, job) {
  const errors = [], quotes = [], texts = new Map()
  const checkQuote = (item, field) => {
    if (typeof item?.path !== 'string' || typeof item.quote !== 'string' || !item.quote.trim()) errors.push(`${field}需要evidence:{path,quote}，quote为连续原文短句`)
    else quotes.push({ item, field })
  }
  for (const [i, row] of data.chapters.entries()) {
    if (!Array.isArray(row.evidence) || !row.evidence.length) errors.push(`chapters[${i}].evidence需要本章当前稿的引文数组`)
    else row.evidence.forEach((item, n) => checkQuote(item, `chapters[${i}].evidence[${n}]`))
  }
  if (data.issues !== undefined && !Array.isArray(data.issues)) errors.push('issues需要数组')
  for (const [i, issue] of (Array.isArray(data.issues) ? data.issues : []).entries()) {
    if (typeof issue?.text !== 'string' || !issue.text.trim()) errors.push(`issues[${i}].text需要非空文本；把rule/quote/fix等判断保留并合并到text，不用只填分项或标题`)
    checkQuote(issue?.evidence, `issues[${i}].evidence`)
  }
  for (const [i, item] of (Array.isArray(data.resolutions) ? data.resolutions : []).entries()) if (item.status === 'resolved') checkQuote(item.evidence, `resolutions[${i}].evidence`)
  if (data.verdict === 'passed') for (const dimension of dimensions(project)) {
    const grade = data.grades?.[dimension]
    if (!['A', 'B'].includes(grade?.grade) || typeof grade.reason !== 'string' || !grade.reason.trim()) errors.push(`grades.${dimension}需要{grade:"A"或"B",reason:"真实依据"}；不把“良好/合格”当字母，不为过校验提升实质判决`)
  }
  const allowed = new Set(job.chapters.map(chapter => latest(project, chapter)?.path).filter(Boolean))
  for (const { item, field } of quotes) {
    const path = portable(root, local(root, item.path))
    if (!allowed.has(path)) continue // 范围与路径由正式校验给出错误，不读取其他文件。
    if (!texts.has(path)) texts.set(path, await textFile(local(root, path)))
    if (!texts.get(path).includes(item.quote)) errors.push(`${field}.quote不在当前稿 ${path}：${JSON.stringify(item.quote.slice(0, 140))}；逐字复制连续短句即可，不拼接、省略或补引号，无需引用整段对话`)
  }
  return errors
}
export async function submitReview(root, project, data, taskId = null, { checkOnly = false } = {}) {
  // 接回1.0.1实测已经生成的警告报告；仍按问题及原有通过检查判断，不丢弃已做的冷读。
  if (data.verdict === 'warned') data = { ...data, originalVerdict: 'warned', verdict: (data.issues ?? []).some(issueBlocks) ? 'rework' : 'passed' }
  if (project.scope.mode === 'pause') throw new Error('当前已暂停，不提交新的审阅结果')
  if (!['passed', 'rework'].includes(data.verdict) || typeof data.summary !== 'string' || !data.summary.trim() || !Array.isArray(data.chapters) || !data.chapters.length || data.chapters.some(row => !row || typeof row !== 'object')) throw new Error('审阅需要 passed/rework、summary 与逐章记录')
  const job = requireJob(project, taskId, '复核', undefined, ['review', 'final-review'])
  if (data.chapters.length !== job.chapters.length || data.chapters.some(row => !job.chapters.includes(row.chapter))) throw new Error('审阅结果必须完整对应任务单范围')
  if (data.chapters.some(row => latest(project, row.chapter)?.authorAgent === job.agent)) throw new Error('复核子代理必须独立于文笔子代理，不能自审')
  if (new Set(data.chapters.map(x => x.chapter)).size !== data.chapters.length) throw new Error('审阅章节不能重复')
  const kind = job.action === 'final-review' ? 'final' : 'batch'
  if (data.kind !== undefined && data.kind !== kind) throw new Error('审阅 kind 必须与任务动作一致，普通复核不能升级最终验收')
  if (data.verdict === 'rework' && data.chapters.every(row => row.verdict === 'passed')) throw new Error('整单rework至少有一章明确rework，不能逐章全通过却保留整体返修判决')
  const fieldErrors = await reviewFieldErrors(root, project, data, job)
  if (fieldErrors.length) {
    const error = new Error(`复核结果预检发现${fieldErrors.length}项字段或引文问题（只修原结果，不重派整批冷读）：\n${fieldErrors.slice(0, 20).join('\n')}${fieldErrors.length > 20 ? '\n其余问题修正后继续检查' : ''}`)
    error.code = 'REVIEW_RESULT_INVALID'; error.problems = fieldErrors
    throw error
  }
  const outlineCache = new Map()
  for (const row of data.chapters) {
    if (row.verdict !== undefined && !['pending', 'passed', 'rework'].includes(row.verdict)) throw new Error('逐章verdict为passed或rework')
    if (data.verdict === 'passed' && row.verdict === 'rework') throw new Error('通过报告不能含返修章')
    if (kind !== 'final' && !inScope(project, row.chapter)) throw new Error('审阅超出当前授权范围')
    const version = latest(project, row.chapter)
    if (!version || version.version !== row.version || version.path !== row.path || !sameStamp(version.stamp, row.stamp) || !await versionValid(root, version)) throw new Error(`第${pad(row.chapter)}章审阅版本已变化`)
    if (!same(row.contract, await contract(root, project, row.chapter, { outlineCache }))) throw new Error(`第${pad(row.chapter)}章依据已变化，重建受影响审阅`)
    if (!row.evidence?.length) throw new Error('逐章审阅必须引用实际正文')
    for (const item of row.evidence) {
      if (portable(root, local(root, item.path)) !== version.path) throw new Error('逐章审阅证据必须来自本章当前版本')
      await evidence(root, item)
    }
    if (data.verdict === 'passed' || row.verdict === 'passed') {
      if (!version.receipt || [row.outlineComplete, row.requirementsMet, row.logicChecked, row.styleChecked].some(value => value !== true)) throw new Error('本章两更或内容审阅尚未完成，检查项必须是布尔 true')
      const length = lengthInfo(project, row.chapter, version.words)
      if (['红', '缺底本'].includes(length.verdict)) throw new Error(`第${pad(row.chapter)}章篇幅不符合用户设置或缺少底本：${JSON.stringify(length)}`)
      if (project.mode === '改编精修' && !row.lengthReason?.trim()) throw new Error('改编审阅需要说明场景完整性与篇幅判断，不以比例代替内容判断')
    }
  }
  if (kind === 'final' && (data.chapters.length !== project.end - project.start + 1 || nextChapter(project) <= project.end || data.chapters.some(x => x.chapter < project.start || x.chapter > project.end))) throw new Error('最终验收必须覆盖全书')
  if (data.issues !== undefined && !Array.isArray(data.issues)) throw new Error('审阅 issues 必须是数组')
  const reviewRows = new Map(data.chapters.map(row => [row.chapter, row])), normalizedIssues = []
  for (const issue of data.issues ?? []) {
    if (!issue.text?.trim()) throw new Error('审阅问题需要 text')
    const { from, to } = issueRange(issue)
    if (to < from || from < project.start || to > project.end || to - from + 1 > reviewRows.size) throw new Error('问题范围必须完全属于本次被审章节')
    for (let id = from; id <= to; id++) if (!reviewRows.has(id)) throw new Error('问题范围不能跨越未审章节')
    const evidencePath = issue.evidence?.path && portable(root, local(root, issue.evidence.path))
    if (![...reviewRows.values()].some(row => row.chapter >= from && row.chapter <= to && row.path === evidencePath)) throw new Error('问题证据必须来自问题范围内的被审当前版本')
    const severity = issue.severity ?? 'red', requiresUser = issue.requiresUser ?? false
    if (!['red', 'yellow', 'info'].includes(severity) || typeof requiresUser !== 'boolean') throw new Error('问题 severity 为 red/yellow/info，requiresUser 为布尔值')
    if (issue.blocking !== undefined && typeof issue.blocking !== 'boolean' || severity === 'red' && issue.blocking === false) throw new Error('blocking为布尔值，红项必须阻塞')
    if (issue.id && project.issues.some(old => old.id === issue.id)) throw new Error('已有问题请填resolutions逐项复验，不重复新增同一ID')
    normalizedIssues.push({ ...issue, from, to, severity, requiresUser, blocking: issueBlocks({ ...issue, severity }), evidence: await evidence(root, issue.evidence) })
  }
  if (data.resolutions !== undefined && !Array.isArray(data.resolutions)) throw new Error('resolutions必须为逐项复验数组')
  const resolutions = [], resolved = new Set()
  for (const item of data.resolutions ?? []) {
    const issue = project.issues.find(issue => issue.id === item.id && issue.status === 'open')
    if (!issue || resolutions.some(old => old.id === item.id) || !['open', 'resolved'].includes(item.status)) throw new Error('复验ID必须是当前开放问题且不能重复，status为open/resolved')
    if (![...reviewRows.keys()].some(id => id >= issue.from && id <= issue.to)) throw new Error('问题复验超出本次审阅范围')
    if (item.status === 'resolved') {
      if (issue.requiresUser) throw new Error('需要作者裁决的问题不能由复核代为关闭，请先登记真实裁决依据')
      for (let id = issue.from; id <= issue.to; id++) if (!reviewRows.has(id)) throw new Error('关闭问题必须审阅其完整影响范围')
      if (!item.resolution?.trim()) throw new Error('问题复验需要resolution说明')
      const row = [...reviewRows.values()].find(row => row.chapter >= issue.from && row.chapter <= issue.to && row.path === portable(root, local(root, item.evidence?.path ?? '')))
      if (!row) throw new Error('解决证据必须来自问题范围内的当前被审版本')
      resolutions.push({ ...item, evidence: await evidence(root, item.evidence) }); resolved.add(item.id)
    } else resolutions.push({ id: item.id, status: 'open', resolution: item.resolution ?? '' })
  }
  // 省略的旧问题仍保持开放，并留下本次确实覆盖哪些问题的逐章观察记录。
  for (const issue of openIssues(project)) if ([...reviewRows.keys()].some(id => id >= issue.from && id <= issue.to) && !resolutions.some(item => item.id === issue.id)) {
    resolutions.push({ id: issue.id, status: 'open', resolution: '' })
  }
  if (data.verdict === 'passed') {
    for (const key of dimensions(project)) if (!['A', 'B'].includes(data.grades?.[key]?.grade) || !data.grades[key].reason?.trim()) throw new Error(`${key} 需要 A/B 评分和依据`)
    if (normalizedIssues.some(issueBlocks)) throw new Error('通过报告不能含未处理的阻塞问题')
    if (openIssues(project).some(issue => issueBlocks(issue) && !resolved.has(issue.id) && [...reviewRows.keys()].some(id => id >= issue.from && id <= issue.to))) throw new Error('仍有未关闭阻塞问题，请由独立复核在resolutions中给出新版证据')
  }
  for (const row of data.chapters.filter(row => row.verdict === 'passed')) {
    if (normalizedIssues.some(issue => issueBlocks(issue) && issue.from <= row.chapter && issue.to >= row.chapter) ||
        openIssues(project, row.chapter).some(issue => issueBlocks(issue) && !resolved.has(issue.id))) throw new Error('逐章通过不能含本章或跨章未关闭阻塞问题')
  }
  const review = { ...data, kind, issues: normalizedIssues,
    resolutions,
    chapters: data.chapters.map(row => ({ ...row, verdict: ['passed', 'rework'].includes(row.verdict) ? row.verdict : data.verdict,
      length: lengthInfo(project, row.chapter, latest(project, row.chapter).words) })),
    task: job.id, reviewerAgent: job.agent, id: `review-${project.reviews.length + 1}`, time: new Date().toISOString() }
  if (checkOnly) return { valid: true, verdict: review.verdict, chapters: review.chapters.map(row => ({ chapter: row.chapter, version: row.version, verdict: row.verdict })),
    issues: review.issues.length, resolutions: resolutions.length }
  project.reviews.push(review)
  for (const item of resolutions.filter(item => item.status === 'resolved')) {
    const issue = project.issues.find(issue => issue.id === item.id)
    issue.history = [...(issue.history ?? []), { ...issue, history: undefined }]
    Object.assign(issue, item, { revision: (issue.revision ?? 1) + 1, reviewedBy: review.id,
      resolvedBy: { review: review.id, task: job.id, agent: job.agent } })
  }
  for (const issue of normalizedIssues) project.issues.push({ ...issue, id: `I${project.issues.length + 1}`, revision: 1, status: 'open', review: review.id, history: [] })
  for (const issue of project.issues.filter(x => x.status === 'open')) if (review.chapters.some(row => row.chapter >= issue.from && row.chapter <= issue.to)) issue.reviewedBy = review.id
  if (kind === 'final' && data.verdict === 'passed') project.gates[5] = { passed: true, evidence: review.id }
  const path = await managedPath(root, project.paths.reports, `${review.id}.md`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `# ${kind === 'final' ? '全书' : '批次'}审阅 · ${review.id}\n\n- 结论：${review.verdict}\n- 时间：${review.time}\n\n${review.summary}\n\n| 章 | 版本 | 逐章判决 | 正文汉字 | 底本比例 |\n|---|---|---|---:|---:|\n${review.chapters.map(r => `| ${r.chapter} | v${r.version} | ${r.verdict} | ${r.length.words} | ${r.length.ratio === null ? '—' : (r.length.ratio * 100).toFixed(2) + '%'} |`).join('\n')}\n\n## 评分依据\n\n${Object.entries(review.grades ?? {}).map(([k, v]) => `- ${k}：${v.grade}；${v.reason}`).join('\n')}\n\n## 引文证据\n\n${review.chapters.map(r => `### 第${pad(r.chapter)}章\n${r.evidence.map(e => `- ${e.path}：「${e.quote}」`).join('\n')}`).join('\n\n')}\n`, { flag: 'wx' })
  project.checkpoint = { time: review.time, nextAction: 'doctor', review: review.id, scopeRevision: project.scope.revision }
  await save(root, project)
  return { review, path }
}
export async function safeFix(root, project) {
  const added = await registerFiles(root, project)
  for (const [name, title] of [[project.paths.notes, '注意事项'], [project.paths.experience, '经验文档']]) {
    if (!existsSync(local(root, name))) {
      const full = await managedPath(root, dirname(local(root, name)), local(root, name))
      await mkdir(dirname(full), { recursive: true }); await writeFile(full, `# ${title}\n`, 'utf8')
    }
  }
  await save(root, project)
  return { registered: added, literaryChanges: 0, approvalsAdded: 0 }
}
