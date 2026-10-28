import { open, readdir, stat, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, relative, basename } from 'node:path'
import { safePath, inside } from './paths.mjs'

export const purposes = {
  idea: { label: '设想与立项', path: '01-设想.md', match: /设想|立项|创作目标/ },
  world: { label: '世界与规则', path: '01-世界.md', match: /世界|战力|能力设定|规则设定/ },
  characters: { label: '人物档案', path: '02-人设/人物档案.md', match: /人物|角色|人设/ },
  outline: { label: '剧情大纲', path: '03-大纲.md', match: /剧情总纲|剧情大纲|全书大纲|情节.*方案|(?:^|\/)03-大纲/ },
  style: { label: '文风与语言', path: '04-文风.md', match: /文风|用词描写|语言风格/ },
  synopsis: { label: '总纲与结构', path: '05-总纲要.md', match: /总纲要|全书逐章大纲|结构映射|资源与伏笔衔接/ },
  notes: { label: '注意事项', path: '07-注意事项.md', match: /注意事项|禁忌/ },
  experience: { label: '写作经验', path: '08-经验文档.md', match: /经验/ },
}
export const rolePurposes = { 主编: ['idea', 'outline', 'style', 'synopsis'], 世界: ['world', 'synopsis'], 人物: ['characters'], 剧情: ['outline', 'synopsis'] }
const archived = path => /(?:^|\/)(?:归档|历史|旧版|废弃|archive|obsolete)(?:[^/]*)(?:\/|$)/i.test(path)
const referenceOnly = path => /(?:^|\/)(?:阅读工作底稿|阅读笔记)(?:\/|$)|正文写作依据\/角色卡\/(?:文笔|复核|主编|世界|人物|剧情)\.md$|(?:细纲审查|核对记录|精修记录)/.test(path)
const portable = (root, path) => relative(root, resolve(root, path)).replace(/\\/g, '/')
const defaultPath = (project, kind) => kind === 'notes' || kind === 'experience' ? project?.paths?.[kind] ?? purposes[kind].path : purposes[kind].path

async function sample(path) {
  const handle = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(8192), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    return new TextDecoder('utf-8').decode(bytes.subarray(0, bytesRead), { stream: bytesRead === bytes.length }).replace(/^\uFEFF/, '')
  } finally { await handle.close() }
}
export async function inventory(root, project = null, options = {}) {
  const cache = options.cache, key = `documents:${resolve(root)}`
  if (cache?.has(key)) return cache.get(key)
  const work = (async () => {
    const paths = new Set(), excluded = new Set(['node_modules', 'novel-workshop', 'dist', 'build', 'target', 'coverage', '__pycache__', '实测记录'])
    async function scan(directory, recursive) {
      if (['body', 'reports', 'output'].some(kind => project?.paths?.[kind] && inside(resolve(root, project.paths[kind]), directory))) return
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || excluded.has(entry.name)) continue
        const path = join(directory, entry.name)
        if (['正文', '章节', '章稿', '成书', '验收', '复核报告'].includes(entry.name) && entry.isDirectory()) continue
        if (entry.isFile() && /\.(md|txt)$/i.test(entry.name) && !/^AGENTS(?:\.override)?\.md$/i.test(entry.name) &&
          !/^(?:第\d+章(?:-v\d+)?|\d+(?:-\d+)?)\.(?:md|txt)$/i.test(entry.name)) paths.add(path)
        else if (entry.isDirectory() && recursive) await scan(path, true)
      }
    }
    await scan(root, false)
    const directories = await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const entry of directories) if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !excluded.has(entry.name) &&
      !['正文', '章节', '章稿', '成书', '验收', '复核报告'].includes(entry.name)) await scan(join(root, entry.name), true)
    for (const kind of Object.keys(purposes)) {
      const path = resolve(root, project?.documents?.[kind]?.path ?? defaultPath(project, kind))
      if (inside(root, path) && existsSync(path)) paths.add(await safePath(root, path))
    }
    const items = []
    for (const path of [...paths].sort()) {
      const name = portable(root, path), info = await stat(path)
      const source = /校勘|底本|原作正文|原著正文|参考\d/.test(name) || project?.source && resolve(root, project.source.path) === path
      const text = source || archived(name) ? '' : await sample(path)
      const lines = text.split(/\r?\n/), headings = []
      for (let i = 0; i < lines.length; i++) if (/^#{1,6}\s+/.test(lines[i])) headings.push({ line: i + 1, title: lines[i].replace(/^#+\s*/, '').trim() })
      const title = headings[0]?.title ?? lines.find(line => line.trim())?.slice(0, 100) ?? basename(path)
      const kinds = source ? ['source'] : Object.entries(purposes).filter(([kind, spec]) =>
        resolve(root, project?.documents?.[kind]?.path ?? defaultPath(project, kind)) === path || spec.match.test(name + '\n' + title)).map(([kind]) => kind)
      if (!source && /细纲|章节大纲|章节规划/.test(name + '\n' + title) && !kinds.includes('chapters')) kinds.push('chapters')
      items.push({ path: name, title, kinds, archived: archived(name), reference: referenceOnly(name), bytes: info.size, modified: info.mtimeMs,
        headings: headings.slice(0, 12), preview: lines.filter(line => line.trim()).slice(0, 4).join('\n').slice(0, 480),
        sampled: info.size > 8192 })
    }
    const targets = {}
    for (const [kind, spec] of Object.entries(purposes)) {
      const binding = project?.documents?.[kind], preferred = binding?.path ?? defaultPath(project, kind)
      const candidates = items.filter(item => !item.archived && !item.reference && item.kinds.includes(kind))
      const selected = binding ? items.find(item => item.path === portable(root, preferred)) :
        candidates.find(item => item.path === portable(root, preferred)) ?? (candidates.length === 1 ? candidates[0] : null)
      targets[kind] = { kind, label: spec.label, path: selected?.path ?? (binding || !candidates.length ? portable(root, preferred) : null),
        exists: Boolean(selected), candidates: candidates.map(item => item.path), status: binding && !selected ? 'missing' : selected ? 'reuse' : candidates.length ? 'choose' : 'missing' }
    }
    return { items, targets, instruction: '先按标题、目录及预览定位，再用read/grep读相关段落；预览不等于全文已读。已有同用途文档优先原位补充；多份候选回查现行要求与入口，不按时间或版本数字猜。只有资料无法解决的作者取舍才询问。' }
  })()
  cache?.set(key, work)
  return work
}
export async function bind(root, project, bindings, source) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('documents需要用途到已有文件路径的对象')
  if (!source) throw new Error('绑定现有文档需要source说明实际选择依据')
  const prepared = []
  for (const [kind, value] of Object.entries(bindings)) {
    if (!purposes[kind] || typeof value !== 'string' || !/\.(md|txt)$/i.test(value) || /^AGENTS(?:\.override)?\.md$/i.test(basename(value))) throw new Error('文档绑定需要已支持用途及项目内MD/TXT文件')
    const path = await safePath(root, value)
    if (['body', 'reports', 'output'].some(kind => inside(resolve(root, project.paths[kind]), path)) || inside(resolve(root, '.novel-workshop'), path) || portable(root, path) === '00-状态.md') throw new Error('不能把正式正文、验收、成书或工坊状态绑定为策划文档')
    if (!existsSync(path) || !(await stat(path)).isFile()) throw new Error(`文档不存在：${value}`)
    prepared.push([kind, portable(root, path)])
  }
  project.documents ??= {}
  for (const [kind, path] of prepared) {
    project.documents[kind] = { path, source }
    if (kind === 'notes' || kind === 'experience') project.paths[kind] = path
  }
}
export async function reuse(root, project, options = {}) {
  const found = await inventory(root, project)
  const bindings = Object.fromEntries(Object.entries(found.targets).filter(([kind, item]) => item.exists && !project.documents?.[kind] && !options.skip?.includes(kind)).map(([kind, item]) => [kind, item.path]))
  if (Object.keys(bindings).length) await bind(root, project, bindings, '接手时按明确路径或唯一现有文档复用；不据此签阶段门或批准参数')
  return found
}
export async function forRole(root, project, role) {
  const found = await inventory(root, project)
  const kinds = rolePurposes[role] ?? []
  return { targets: kinds.map(kind => found.targets[kind]),
    references: found.items.filter(item => !item.archived && (item.kinds.some(kind => kinds.includes(kind)) || /README|现行要求|执行计划|项目进度/.test(item.path)))
      .map(({ path, title, kinds, reference }) => ({ path, title, kinds, reference })),
    instruction: found.instruction }
}

export function summary(found) {
  return { total: found.items.length, archived: found.items.filter(item => item.archived).length,
    targets: Object.fromEntries(Object.entries(found.targets).map(([kind, item]) => [kind, {
      ...item, candidates: item.candidates.slice(0, 5), candidateCount: item.candidates.length,
    }])), lookup: { action: 'documents', options: { offset: 0, limit: 10 } }, instruction: found.instruction }
}

export async function bindProgress(root, project, paths) {
  if (!Array.isArray(paths)) throw new Error('progressFiles需要已有进度文档路径数组')
  const prepared = []
  for (const value of paths) {
    if (typeof value !== 'string' || !/\.md$/i.test(value) || /^AGENTS(?:\.override)?\.md$/i.test(basename(value))) throw new Error('进度同步只绑定已有Markdown文档')
    const path = await safePath(root, value)
    if (!existsSync(path) || !(await stat(path)).isFile()) throw new Error(`进度文档不存在：${value}`)
    if (['body', 'reports', 'output'].some(kind => inside(resolve(root, project.paths[kind]), path)) || project.outlines?.some(item => resolve(root, item.path) === path) ||
      inside(resolve(root, '.novel-workshop'), path) || path === resolve(root, '00-状态.md') || project.source && path === resolve(root, project.source.path) ||
      ['world', 'characters', 'style'].some(kind => project.documents?.[kind]?.path && path === resolve(root, project.documents[kind].path))) throw new Error('不能把正文、细纲、底本、设定或工坊运行文件绑定为进度文档')
    prepared.push(portable(root, path))
  }
  project.progressFiles = [...new Set(prepared)]
}

export async function discoverProgress(root, project) {
  await bindProgress(root, project, ['docs/README.md', 'docs/项目进度.md', 'docs/正文执行记录.md', 'docs/现行要求与执行计划.md']
    .filter(path => existsSync(resolve(root, path))))
}

export async function syncProgress(root, project) {
  if (!project.progressFiles?.length) return
  const ids = Object.keys(project.chapters).map(Number).filter(id => project.chapters[id].versions?.length).sort((a, b) => a - b)
  let next = project.start
  while (project.chapters[next]?.versions?.length) next++
  const recent = ids.filter(id => id >= project.scope.from && id <= project.scope.to).slice(-10)
  const review = project.reviews.at(-1), open = project.issues.filter(item => item.status === 'open')
  const currentReviews = recent.map(id => {
    const version = project.chapters[id].versions.at(-1)
    const match = project.reviews.findLast(item => item.chapters.some(row => row.chapter === id && row.version === version.version))
    const row = match?.chapters.find(row => row.chapter === id && row.version === version.version)
    return `${id}-v${version.version}：${!version.receipt ? '缺两更、待独立复核' : match ? `${match.id} ${row.verdict ?? match.verdict}（有效性以doctor为准）` : '待独立复核'}`
  })
  const body = `<!-- novel-workshop:progress:start -->\n## 工坊当前进度\n\n此段由制作登记同步；下方原有要求、计划与历史记录保留。\n\n- 当前授权：${project.scope.mode}，${project.scope.from}—${project.scope.to}；依据：${project.scope.source}\n- 实际落盘：${ids.length}个位置；下一空缺章：${next > project.end ? '无' : next}\n- 本轮最新章稿：${recent.map(id => `${id}-v${project.chapters[id].versions.at(-1).version}`).join('、') || '无'}\n- 当前采用稿复核：${currentReviews.join('；') || '无本轮章稿'}\n- 最近历史复核（不代替当前稿）：${review ? `${review.id} ${review.verdict}（${review.chapters.map(row => `${row.chapter}-v${row.version}`).join('、')}）；报告：${project.paths.reports}/${review.id}.md` : '尚无正式复核，不把历史落盘视为通过'}\n- 开放问题：${open.filter(item => item.severity === 'red' || (item.blocking ?? item.severity !== 'info')).length}项阻塞，${open.filter(item => item.severity === 'info' && item.blocking !== true).length}项非阻塞建议\n- 最近经验：${project.experiences.filter(item => item.status === 'active').slice(-3).map(item => item.text).join('；') || '无新增'}\n- 接续：先doctor读取实际状态；${next > project.scope.to ? '已到本轮授权终点，不自动续写下一章' : `下一未写${next}，仍按当前授权完成制作与复核`}\n\n<!-- novel-workshop:progress:end -->`
  for (const name of project.progressFiles) {
    const path = await safePath(root, name)
    let bytes
    try { bytes = await readFile(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const block = /<!-- novel-workshop:progress:start -->[\s\S]*?<!-- novel-workshop:progress:end -->/
    const heading = /^(\uFEFF?(?:# [^\r\n]*\r?\n)?)/.exec(text)[0]
    const existing = text.match(block)?.[0]
    const manual = existing && !/\r?\n## 工坊当前进度\r?\n/.test(existing) ? existing.replace(/<!-- novel-workshop:progress:(?:start|end) -->/g, '').trim() : ''
    const retained = manual ? `\n\n<details>\n<summary>同步前人工进度记录（历史保留）</summary>\n\n${manual}\n\n</details>` : ''
    const updated = existing ? text.replace(block, () => body + retained) : heading + '\n' + body + '\n\n' + text.slice(heading.length)
    if (updated === text) continue
    const before = await stat(path)
    await writeFile(path, updated, 'utf8')
    const after = await stat(path)
    // 只刷新本次自动进度段造成的时间变化；外部修改仍交doctor核对。
    for (const item of [...project.requirements, ...project.facts]) if (item.evidence?.path && resolve(root, item.evidence.path) === path &&
      item.evidence.stamp?.size === before.size && item.evidence.stamp?.mtime === before.mtimeMs && text.includes(item.evidence.quote)) {
      item.evidence.stamp = { size: after.size, mtime: after.mtimeMs }
    }
  }
}
