import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import * as P from './project.mjs'
import * as W from './production.mjs'
import * as T from './tasks.mjs'
import { safePath, managedPath } from './paths.mjs'

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const microKinds = new Set(['format', 'punctuation', 'typo'])
const substantive = new Set(['count', 'timeline', 'name', 'reference', 'ability', 'motivation', 'causality', 'scene', 'structure'])

export async function triage(root, project, data) {
  if (project.scope.mode === 'pause') throw new Error('当前已暂停，不处理制作分流')
  const review = project.reviews.find(row => row.id === data.review)
  if (!review?.triage) throw new Error('需要已收件、等待队长分流的复核ID')
  if (same(review.triage.decisions, data.decisions)) return review.triage
  const allIds = review.triage.issues.filter(id => project.issues.some(issue => issue.id === id && issue.status === 'open'))
  const pending = review.triage.status === 'pending' ? review.triage.pendingIssues ?? allIds : allIds
  const ids = pending.filter(id => project.issues.some(issue => issue.id === id && issue.status === 'open' && issue.from >= project.scope.from && issue.to <= project.scope.to))
  if (!Array.isArray(data.decisions) || data.decisions.length !== ids.length || new Set(data.decisions.map(row => row.id)).size !== ids.length ||
      data.decisions.some(row => !ids.includes(row.id))) throw new Error('分流必须逐项覆盖本次仍开放的问题，不提前自动派返修')
  for (const decision of data.decisions) {
    const issue = project.issues.find(row => row.id === decision.id)
    if (!decision.reason?.trim() || !['ignore', 'micro', 'repair', 'plan', 'clarify', 'author'].includes(decision.route)) throw new Error('分流需要route及有依据的reason')
    if (issue.from < project.scope.from || issue.to > project.scope.to) throw new Error('先取得覆盖问题完整影响范围的授权')
    if (issue.requiresUser && decision.route !== 'author') throw new Error('作者裁决项不能由队长放行或代修')
    if (decision.route === 'ignore' && P.issueBlocks(issue)) throw new Error('实质阻塞不能降级忽略；证据存疑交原复核clarify')
    if (decision.route === 'micro' && (project.microfixes ?? []).some(fix => fix.status === 'needs-repair' && fix.issues.includes(issue.id))) throw new Error('微修未解决问题，转文笔repair或先plan，不循环微修')
    if (decision.route === 'micro' && (!microKinds.has(decision.kind) || substantive.has(issue.category) || issue.from !== issue.to)) throw new Error('微修仅限单章排版、误重复标点或有唯一依据的个别错字；实质问题交文笔')
    for (const row of review.chapters.filter(row => row.chapter >= issue.from && row.chapter <= issue.to)) {
      const current = P.latest(project, row.chapter)
      if (current?.version !== row.version || !await P.versionValid(root, current) || !P.sameContract(row.contract, await P.contract(root, project, row.chapter))) throw new Error('分流依据已变化，先独立复验实际变化，不沿用旧报告')
    }
  }
  const time = new Date().toISOString()
  const remaining = pending.filter(id => !ids.includes(id) && project.issues.some(issue => issue.id === id && issue.status === 'open'))
  review.triage = { previous: review.triage.status === 'completed' ? review.triage : review.triage.previous,
    status: remaining.length ? 'pending' : 'completed', pendingIssues: remaining, issues: allIds,
    decisions: [...(review.triage.decisions ?? []).filter(row => !ids.includes(row.id)), ...data.decisions], time }
  for (const decision of data.decisions) {
    const issue = project.issues.find(row => row.id === decision.id)
    issue.triage = { ...decision, review: review.id, time }
    if (decision.route === 'ignore') issue.status = 'declined'
    if (decision.route === 'author') issue.requiresUser = true
  }
  await P.save(root, project)
  return review.triage
}

export async function microfix(root, project, data) {
  const ids = data.issues ?? (data.issue ? [data.issue] : [])
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('微修需要明确且不重复的问题ID')
  const issues = ids.map(id => project.issues.find(row => row.id === id && row.status === 'open'))
  if (issues.some(issue => !issue || issue.triage?.route !== 'micro' || !microKinds.has(issue.triage.kind) || issue.requiresUser || substantive.has(issue.category))) throw new Error('只能处理已由队长分流为明确微修的问题')
  const chapter = issues[0].from, kind = issues[0].triage.kind, sourceReview = issues[0].triage.review
  if (issues.some(issue => issue.from !== chapter || issue.to !== chapter || issue.triage.kind !== kind || issue.triage.review !== sourceReview)) throw new Error('同一微修只处理同章、同类及同一依据的问题')
  if (!['continue', 'revise'].includes(project.scope.mode) || !W.inScope(project, chapter)) throw new Error('当前授权不允许微修正文')
  if (project.jobs.some(job => ['pending', 'running'].includes(job.status))) throw new Error('先收完当前岗位，微修不能与岗位提交并发')
  const current = P.latest(project, chapter), review = project.reviews.find(row => row.id === sourceReview)
  const reviewed = review?.chapters.find(row => row.chapter === chapter)
  if (!current || current.version !== data.version || reviewed?.version !== current.version || !await P.versionValid(root, current) ||
      !P.sameContract(reviewed.contract, await P.contract(root, project, chapter))) throw new Error('微修版本或依据已变化，需要重新分流')
  if ((await W.approvals(root, project)).approved.get(chapter)?.version === current.version && !project.scope.reviseApproved) throw new Error('已有通过稿缺少reviseApproved修订授权')
  await W.assertWriteReady(root, project, chapter)
  const before = await P.textFile(P.local(root, current.path))
  let text = before
  if (kind === 'format') {
    if (data.patches !== undefined) throw new Error('纯排版只接收format，不接收正文替换')
    text = T.formatManuscript(text, data.format)
    if (!T.compareText(before, text).formatOnly) throw new Error('排版必须实际变化且字句未变')
  } else {
    if (data.format !== undefined || !Array.isArray(data.patches) || !data.patches.length || data.patches.length > issues.length) throw new Error('字词微修需要与具体问题对应的有限patches，不夹带排版')
    for (const patch of data.patches) {
      if (!ids.includes(patch.issue) || typeof patch.before !== 'string' || !patch.before || typeof patch.after !== 'string' || patch.before === patch.after) throw new Error('每处补丁需要issue、唯一原句before及实际替换after')
      const at = text.indexOf(patch.before)
      if (at < 0 || text.indexOf(patch.before, at + 1) >= 0 || !issues.find(issue => issue.id === patch.issue).evidence?.quote ||
          !patch.before.includes(issues.find(issue => issue.id === patch.issue).evidence.quote)) throw new Error('原句必须唯一匹配，并覆盖该问题的实际引文')
      if (kind === 'punctuation') {
        if (patch.before.replace(/([，。！？；：、])\1+/gu, '$1') !== patch.after) throw new Error('标点微修只能删除误重复标点')
      } else {
        const old = [...patch.before], next = [...patch.after], changed = old.flatMap((char, index) => char !== next[index] ? [index] : [])
        if (old.length !== next.length || changed.length !== 1 || !/^[\p{Script=Han}\p{L}]$/u.test(old[changed[0]]) || !/^[\p{Script=Han}\p{L}]$/u.test(next[changed[0]])) throw new Error('错字微修仅允许有唯一依据的单字替换；数量、时间或实质改写走文笔')
        const authority = await P.evidence(root, patch.authority)
        const allowed = [...P.relevant(project, 'requirements', chapter).map(row => row.evidence?.path),
          project.documents?.style?.path, ...project.materials.filter(row => row.status === 'active' && row.kind === 'rule' && (row.from ?? project.start) <= chapter && (row.to ?? project.end) >= chapter).map(row => row.path)].filter(Boolean)
        if (!allowed.includes(authority.path) || !authority.quote.includes(next[changed[0]]) || !patch.reason?.trim()) throw new Error('错字须引用现行作者规则或文风依据的真实原句及唯一修法；无法取证转文笔')
      }
      text = text.slice(0, at) + patch.after + text.slice(at + patch.before.length)
    }
    if (ids.some(id => !data.patches.some(patch => patch.issue === id))) throw new Error('微修不能声称处理没有补丁的问题')
  }
  const id = `micro-${(project.microfixes?.length ?? 0) + 1}`, nextVersion = current.version + 1
  const path = await managedPath(root, project.paths.body, `第${P.pad(chapter)}章-v${nextVersion}.md`)
  const diffPath = await safePath(root, `.novel-workshop/microfixes/${id}/diff.json`)
  const fix = { id, chapter, kind, issues: ids, sourceReview, sourceTask: review.task, reviewerAgent: review.reviewerAgent,
    beforeVersion: current.version, afterVersion: nextVersion, beforePath: current.path, afterPath: P.portable(root, path),
    beforeContract: reviewed.contract, status: 'pending-confirmation', time: new Date().toISOString(),
    patches: data.patches ?? [], format: data.format, diffPath: P.portable(root, diffPath), comparison: T.compareText(before, text) }
  await mkdir(dirname(diffPath), { recursive: true })
  await writeFile(diffPath, JSON.stringify({ ...fix, before, after: text }, null, 2) + '\n', { flag: 'wx' })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, { flag: 'wx', encoding: 'utf8' })
  project.chapters[chapter].versions.push({ ...current, version: nextVersion, path: fix.afterPath, stamp: await P.stamp(path), words: P.measure(text),
    receipt: current.receipt ? { ...current.receipt, time: fix.time, inheritedFrom: current.version } : null,
    task: null, microfix: id, authorAgent: current.authorAgent })
  project.microfixes ??= []; project.microfixes.push(fix)
  const mechanical = kind === 'format' && W.dimensions(project).every(name => ['A', 'B'].includes(review.grades?.[name]?.grade)) &&
    [reviewed.outlineComplete, reviewed.requirementsMet, reviewed.logicChecked, reviewed.styleChecked].every(value => value === true) && current.receipt &&
    W.openIssues(project, chapter).filter(P.issueBlocks).every(issue => ids.includes(issue.id))
  if (mechanical) {
    fix.status = 'confirmed'; fix.confirmedBy = { type: 'program', rule: 'format-only', sourceReview }
    const certificateId = `review-${project.reviews.length + 1}`
    for (const issue of issues) { issue.status = 'resolved'; issue.resolution = '程序确认仅排版，字句与已独立复核原稿一致'; issue.resolvedBy = { microfix: id, type: 'program' }; issue.reviewedBy = certificateId }
    const version = P.latest(project, chapter)
    const certificate = { id: certificateId, kind: 'batch', verdict: 'passed', summary: '纯排版差异由程序确认，继承原独立复核的内容检查。',
      sourceReview, mechanicalConfirmation: id, reviewerAgent: null, grades: review.grades, issues: [], resolutions: [], time: fix.time,
      chapters: [{ ...reviewed, version: version.version, path: version.path, stamp: version.stamp, contract: await P.contract(root, project, chapter), verdict: 'passed',
        evidence: [{ path: version.path, quote: P.chapterText(text).body.trim().slice(0, 80) }], length: P.lengthInfo(project, chapter, version.words) }] }
    const reportPath = await managedPath(root, project.paths.reports, `${certificateId}.md`)
    await writeFile(reportPath, `# 纯排版确认 · ${certificateId}\n\n原独立复核：${sourceReview}\n微修差异：${fix.diffPath}\n\n只确认字句未变，不产生新的文学评分。\n`, { flag: 'wx' })
    project.reviews.push(certificate)
  }
  await P.save(root, project)
  return fix
}

export function reusableAgent(project, job, runtime) {
  const fix = job.microfix && project.microfixes?.find(row => row.id === job.microfix)
  return project.jobs.findLast(old => old.id !== job.id && old.status === 'completed' && old.role === job.role && old.agent && old.runtime === runtime &&
    (fix ? old.agent === fix.reviewerAgent : old.batchKey === job.batchKey) &&
    !project.jobs.some(active => active.id !== job.id && active.agent === old.agent && ['pending', 'running'].includes(active.status)))?.agent ?? null
}

export async function advance(root, project, data = {}) {
  const host = data.runtime ?? 'codex-native-v1'
  if (!T.nativeRuntimes.includes(host)) throw new Error(`不支持的运行时标识：${host}（只支持 ${T.nativeRuntimes.join(' / ')}）`)
  let result, queued
  if (data.requeue !== undefined) {
    if (data.requeue !== true || typeof data.id !== 'string' || data.agent || data.reuse || data.contextRetained) {
      throw new Error('--requeue 需要 --id 和新的原生代理，不能与 --reuse、--agent、--context-retained 同用')
    }
    queued = await T.requeueInterrupted(root, project, data.id)
  } else if (data.id) {
    const old = project.jobs.find(job => job.id === data.id)
    result = ['failed', 'cancelled'].includes(old?.status) && old.committed?.length ? T.taskInfo(root, old) : await T.collect(root, project, data.id)
  }
  let prepared = queued
  try {
    const diagnosis = await W.diagnose(root, project), next = diagnosis.nextAction
    if (!prepared && (next.requiresUser || next.call?.action !== 'dispatch')) return { result: T.publicTask(result), diagnosis, handoff: { type: next.type, call: next.call ?? null } }
    prepared ??= await T.dispatch(root, project, next.call.options)
    const current = project.jobs.find(row => row.id === prepared.id)
    const agent = data.agent ?? (data.reuse ? reusableAgent(project, current, host) : null)
    if (agent && !current.agent) { current.runtime = host; await T.updateTask(root, project, { id: current.id, status: 'running', agent }) }
    if (data.contextRetained) await T.useMicroDelta(root, project, current, { contextRetained: true })
    const info = T.taskInfo(root, current)
    return { result: T.publicTask(result), diagnosis, prepared: T.publicTask(info), handoff: { type: current.agent ? 'followup' : 'spawn', agent: current.agent,
      nativeCallRequired: true, promptPath: info.promptPath, contextPath: info.contextPath, resultPath: info.resultPath,
      instruction: current.agent ? '本单已绑定同岗位代理；用宿主原生唤醒调用实际启动执行，不把仅追加消息当启动。' : '先原生spawn只读准备，取得真实ID后task绑定，再用宿主原生唤醒调用确认开始。' } }
  } catch (error) {
    const saved = []
    if (result?.status === 'completed') saved.push(`任务 ${result.id} 已收件`)
    if (prepared) saved.push(`任务 ${prepared.id} 已准备`)
    if (!saved.length) throw error
    throw new Error(`${saved.join('，')}。后续步骤失败：${error.message}。可运行 doctor 查看当前状态`, { cause: error })
  }
}
