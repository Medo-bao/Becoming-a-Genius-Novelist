import { existsSync } from 'node:fs'
import { readdir, lstat, readFile, writeFile, mkdir, rename, rmdir } from 'node:fs/promises'
import { resolve, relative, dirname, basename, isAbsolute } from 'node:path'
import * as P from './project.mjs'
import * as W from './production.mjs'
import { inside, safePath } from './paths.mjs'

const folders = { tasks: '任务记录', drafts: '临时草稿', reviews: '复核草案', receipts: '阅读回执', temporary: '临时资料', cleanup: '清理记录', research: '研究摘录' }
const roles = new Set(['主编', '世界', '人物', '剧情', '文笔', '复核'])
const freeText = new Set(['text', 'quote', 'before', 'after', 'notes', 'experience', 'summary', 'resolution', 'reason', 'instruction', 'source'])
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

function protectedPaths(root, project) {
  const paths = new Set(), add = value => { if (typeof value === 'string' && value) paths.add(resolve(root, value)) }
  for (const name of ['body', 'outline', 'reports', 'output']) {
    const path = resolve(root, project.paths[name])
    if (key(path) !== key(root)) paths.add(path)
  }
  for (const value of [project.paths.notes, project.paths.experience, project.source?.path, project.metadata.cover,
    ...Object.values(project.documents ?? {}).map(item => item.path), ...(project.outlines ?? []).map(item => item.path), ...(project.progressFiles ?? []),
    '01-设想.md', '01-世界.md', '02-人设', '02-世界', '03-大纲.md', '04-文风.md', '05-总纲要.md',
    '00-状态.md', 'AGENTS.md', 'AGENTS.override.md', 'AGENTS.local.md', 'CLAUDE.md', '.git', '.agents', '.codex',
    '.novel-workshop/project.json', '.novel-workshop/core', '.novel-workshop/bin', '.novel-workshop/archive',
    '.novel-workshop/当前要求.md', '.novel-workshop/参数与派单.md']) add(value)
  for (const row of Object.values(project.chapters)) {
    add(row.outline)
    for (const version of row.versions ?? []) add(version.path)
  }
  for (const material of project.materials.filter(item => item.status === 'active' && !item.temporary)) add(material.path)
  for (const record of [...project.requirements, ...project.facts, ...project.issues, ...project.experiences, ...project.exceptions]) {
    if (!['active', 'open', 'pending', 'approved'].includes(record.status)) continue
    add(record.evidence?.path)
    add(record.source?.path)
    if (typeof record.source === 'string' && existsSync(resolve(root, record.source))) add(record.source)
  }
  for (const gate of Object.values(project.gates)) if (gate.passed) add(gate.evidence)
  for (const item of project.exports) for (const path of item.files) add(path)
  for (const review of project.reviews) add(`${project.paths.reports}/${review.id}.md`)
  return [...paths]
}

async function filesWithin(root, path) {
  await safePath(root, path)
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error('路径含链接或目录联接')
  if (info.isFile()) return [path]
  if (!info.isDirectory()) throw new Error('不是普通文件或目录')
  const files = []
  for (const entry of await readdir(path, { withFileTypes: true })) files.push(...await filesWithin(root, resolve(path, entry.name)))
  return files
}

async function plan(root, project, directory) {
  const entries = [], kept = [], protectedFiles = protectedPaths(root, project)
  async function add(path, category, destination) {
    const full = resolve(root, path)
    if (!existsSync(full)) return
    if (protectedFiles.some(item => inside(item, full) || inside(full, item))) {
      kept.push({ path: P.portable(root, full), reason: '当前生产登记或正式文件仍在引用，保留原处' }); return
    }
    try {
      const target = await safePath(root, resolve(directory, destination)), files = await filesWithin(root, full)
      if (!inside(directory, target) || key(target) === key(directory) || existsSync(target)) throw new Error('归档目标冲突或越界')
      if (entries.some(item => inside(item.from, full))) return
      if (entries.some(item => inside(full, item.from))) {
        await children(full, name => add(resolve(full, name), category, `${destination}/${name}`))
        return
      }
      entries.push({ from: full, to: target, category, files })
    } catch (error) { kept.push({ path: P.portable(root, full), reason: error.message }) }
  }
  async function children(path, callback) {
    let entries
    try { await safePath(root, path); entries = await readdir(path, { withFileTypes: true }) }
    catch (error) { if (error.code !== 'ENOENT') kept.push({ path: P.portable(root, path), reason: error.message }); return }
    for (const entry of entries) await callback(entry.name)
  }
  await children(resolve(root, '.novel-workshop/tasks'), async name => {
    const path = resolve(root, '.novel-workshop/tasks', name), job = project.jobs.find(item => key(resolve(root, item.directory)) === key(path))
    const role = job && roles.has(job.role) ? job.role : '未登记任务'
    await add(path, 'tasks', `${folders.tasks}/${role}/${name}`)
  })
  for (const material of project.materials.filter(item => item.temporary === true && item.status === 'active')) {
    const category = ['cleanup', 'research'].includes(material.category) ? material.category : 'temporary'
    const path = resolve(root, material.path)
    await add(path, category, `${folders[category]}/${P.portable(root, path)}`)
  }
  for (const [path, category] of [['drafts', 'drafts'], ['review-drafts', 'reviews'], ['read-receipts', 'receipts']]) {
    await children(resolve(root, '.novel-workshop', path), name => add(resolve(root, '.novel-workshop', path, name), category, `${folders[category]}/${name}`))
  }
  return { entries, kept }
}

function remapper(root, entries) {
  const paths = [...entries].sort((a, b) => b.from.length - a.from.length)
  return function mapPath(value) {
    const prefix = '完整内容见 UTF-8 阅读文件：', inline = value.startsWith(prefix), text = inline ? value.slice(prefix.length) : value
    const path = resolve(root, text), match = paths.find(item => inside(item.from, path))
    if (!match) return value
    const target = resolve(match.to, relative(match.from, path))
    return (inline ? prefix : '') + (isAbsolute(text) ? target : P.portable(root, target))
  }
}
function rewrite(value, mapPath, field = '', inlinePointers = false) {
  if (typeof value === 'string') return freeText.has(field) && !(inlinePointers && value.startsWith('完整内容见 UTF-8 阅读文件：')) ? value : mapPath(value)
  if (Array.isArray(value)) return value.map(item => rewrite(item, mapPath, field, inlinePointers))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, mapPath, key, inlinePointers)]))
  return value
}
async function metadataUpdates(root, entries, mapPath) {
  const updates = []
  for (const entry of entries) for (const file of entry.files) {
    const prompt = entry.category === 'tasks' && key(file) === key(resolve(entry.from, 'prompt.md'))
    if (!file.endsWith('.json') && !prompt) continue
    const before = await readFile(file)
    let text
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before) } catch { continue }
    let after
    if (file.endsWith('.json')) {
      let value
      try { value = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { continue }
      const changed = rewrite(value, mapPath, '', basename(file) === 'context.json' || /[/\\]chapters[/\\]\d+\.json$/.test(file))
      if (JSON.stringify(changed) === JSON.stringify(value)) continue
      after = (text.startsWith('\uFEFF') ? '\uFEFF' : '') + JSON.stringify(changed, null, 2) + '\n'
    } else {
      after = text
      for (const item of [...entries].sort((a, b) => b.from.length - a.from.length)) {
        after = after.split(item.from).join(item.to).split(P.portable(root, item.from)).join(P.portable(root, item.to))
      }
      if (after === text) continue
    }
    updates.push({ path: await safePath(root, mapPath(file)), before, after })
  }
  return updates
}

export async function archive(root, project, options = {}) {
  const report = options.report ?? await W.diagnose(root, project)
  const active = project.jobs.filter(job => ['pending', 'running'].includes(job.status))
  const ready = ['complete', 'archive'].includes(report.stage) && !active.length && project.scope.mode !== 'pause'
  let number = (project.archives?.length ?? 0) + 1, directory
  do { directory = await safePath(root, `.novel-workshop/archive/goal-r${project.scope.revision}-${number++}`) } while (existsSync(directory))
  const planned = await plan(root, project, directory)
  const categories = {}
  for (const entry of planned.entries) categories[folders[entry.category]] = (categories[folders[entry.category]] ?? 0) + entry.files.length
  const summary = { ready, entries: planned.entries.length, files: planned.entries.reduce((sum, entry) => sum + entry.files.length, 0), categories,
    kept: planned.kept.slice(0, 10), keptCount: planned.kept.length,
    ...(ready ? {} : { reason: active.length ? '仍有未收件任务，保留现场，不移动资料' : '当前目标尚未完成或已暂停，不归档', jobs: active.map(job => job.id), stage: report.stage }) }
  if (options.preview) {
    const offset = P.integer(options.offset ?? 0, '归档偏移'), limit = P.integer(options.limit ?? 20, '归档页长', 1)
    return { ...summary, preview: true, offset, items: planned.entries.slice(offset, offset + limit).map(entry => ({ from: P.portable(root, entry.from),
      to: P.portable(root, entry.to), category: folders[entry.category], files: entry.files.length })) }
  }
  if (!ready) throw new Error(summary.reason)
  if (!planned.entries.length) {
    if (project.cleanupScope !== project.scope.revision) { project.cleanupScope = project.scope.revision; await P.save(root, project) }
    return { ...summary, completed: true, moved: 0, index: project.archives?.at(-1)?.index ?? null }
  }
  const mapPath = remapper(root, planned.entries), updates = await metadataUpdates(root, planned.entries, mapPath)
  const updated = rewrite({ ...project, archives: [] }, mapPath), id = basename(directory), index = P.portable(root, resolve(directory, '归档清单.md'))
  const record = { id, directory: P.portable(root, directory), index, time: new Date().toISOString(), scopeRevision: project.scope.revision,
    range: [project.scope.from, project.scope.to], files: summary.files, categories, entries: planned.entries.map(entry => ({ from: P.portable(root, entry.from), to: P.portable(root, entry.to) })) }
  updated.archives = [...(project.archives ?? []), record]; updated.cleanupScope = project.scope.revision
  for (const job of updated.jobs) if (job.directory !== project.jobs.find(item => item.id === job.id)?.directory) job.archivedIn = id
  for (const item of updated.materials) if (item.temporary && item.status === 'active' && item.path !== project.materials.find(old => old.id === item.id)?.path) {
    item.status = 'archived'; item.archivedIn = id
  }
  const moved = [], written = []
  try {
    for (const entry of planned.entries) {
      // 每次目录移动前重新核对源、目标的绝对边界和链接，拒绝覆盖已有归档。
      await safePath(root, entry.from); await safePath(root, entry.to)
      if (!inside(root, entry.from) || !inside(directory, entry.to) || existsSync(entry.to)) throw new Error('归档路径已变化或目标已存在')
      await mkdir(dirname(entry.to), { recursive: true }); await rename(entry.from, entry.to); moved.push(entry)
    }
    for (const update of updates) { written.push(update); await writeFile(await safePath(root, update.path), update.after, 'utf8') }
    await mkdir(directory, { recursive: true })
    await writeFile(await safePath(root, index), `# 目标完成归档 · ${id}\n\n- 授权范围：${record.range.join('—')}\n- 时间：${record.time}\n- 文件数：${record.files}\n- 分类：${JSON.stringify(categories)}\n\n正文各版本、现行规划、正式报告、成书与仍被引用资料保留原位。任务元数据路径已更新，正文和证据引文不改写。\n\n| 原位置 | 归档位置 |\n|---|---|\n${record.entries.map(item => `| ${item.from} | ${item.to} |`).join('\n')}\n\n## 保留原处\n\n${planned.kept.map(item => `- ${item.path}：${item.reason}`).join('\n') || '无额外保留项'}\n`, { flag: 'wx' })
    await P.save(root, updated)
  } catch (error) {
    const saved = await P.jsonFile(await safePath(root, P.MANIFEST)).catch(() => null)
    if (saved?.archives?.some(item => item.id === id)) {
      Object.assign(project, saved)
      throw new Error(`归档及主账已保存，摘要刷新失败，资料保留在${record.directory}：${error.message}`)
    }
    for (const update of written.reverse()) await writeFile(await safePath(root, update.path), update.before)
    for (const entry of moved.reverse()) { await safePath(root, entry.from); await safePath(root, entry.to); await rename(entry.to, entry.from) }
    // 只回移本次已移动的资料；不递归删除，也不清除原有文件。
    try { await rmdir(directory) } catch { /* 失败目录留作追溯，下一次归档另取目录 */ }
    throw error
  }
  Object.assign(project, updated)
  return { ...summary, completed: true, moved: planned.entries.length, id, directory: record.directory, index }
}
