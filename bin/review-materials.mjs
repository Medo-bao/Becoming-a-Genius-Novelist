import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { textFile, pad } from './project.mjs'
import { safePath } from './paths.mjs'

const pointer = '完整内容见 UTF-8 阅读文件：'
const reference = value => typeof value === 'string' && value.startsWith(pointer) ? value.slice(pointer.length) : null
export function readingText(text) {
  let output = '', column = 0
  for (const char of text.replace(/\r\n/g, '\n')) {
    if (char === '\n') column = 0
    else { if (column === 800) { output += '\n'; column = 0 }; column++ }
    output += char
  }
  return output
}

/** 整合完整文学材料；字节/时间戳等程序核对字段留在结构化输入，不要求模型逐行阅读。 */
export async function buildReviewReadings(root, directory, packets) {
  const task = await safePath(root, directory), loaded = [], usage = new Map(), texts = new Map()
  const read = async path => {
    path = await safePath(task, path)
    if (!texts.has(path)) texts.set(path, await textFile(path))
    return texts.get(path)
  }
  function find(value) {
    const path = reference(value)
    if (path) {
      usage.set(path, (usage.get(path) ?? 0) + 1)
    } else if (Array.isArray(value)) for (const item of value) find(item)
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (key !== 'textFiles' && key !== 'readingInstructions') find(item)
  }
  for (const packet of packets) {
    const value = JSON.parse(await readFile(await safePath(task, packet.path), 'utf8'))
    loaded.push({ ...packet, value }); find(value)
  }
  const common = new Map([...usage].filter(([, count]) => count > 1).map(([path], i) => [path, `共享依据${i + 1}`]))
  async function save(path, text) {
    path = await safePath(task, path)
    const content = readingText(text) + '\n'
    await writeFile(path, content, 'utf8')
    return { path, lines: content.split('\n').length - Number(content.endsWith('\n')) }
  }
  let sharedReviewReading = null
  const sharedPath = resolve(task, 'text/复核共享依据.md')
  if (common.size) {
    await mkdir(await safePath(task, resolve(task, 'text')), { recursive: true })
    const sections = []
    for (const [path, label] of common) sections.push(`## ${label}\n\n阅读来源：${relative(dirname(sharedPath), path).replace(/\\/g, '/')}\n\n${await read(path)}`)
    sharedReviewReading = await save(sharedPath, `# 复核共享依据\n\n以下材料为本单重复引用的输入，完整读取一次。\n\n${sections.join('\n\n')}`)
  }
  async function render(value, field, sections) {
    if (field === 'textFiles' || field.endsWith('.textFiles') || field.endsWith('readingInstructions') ||
        ['nextVersion', 'target', 'scope', 'runtime', 'diagnosis', 'manuscript'].includes(field) ||
        field.endsWith('.stamp') || ['dependencies.source.indexed', 'dependencies.source.current', 'dependencies.outline'].includes(field)) return
    const path = reference(value)
    if (path) {
      sections.push(common.has(path) ? `- ${field}：见[${common.get(path)}](../text/复核共享依据.md)` : `\n## ${field}\n\n${await read(path)}\n`)
    } else if (Array.isArray(value)) {
      if (!value.length) sections.push(`- ${field}：[]`)
      for (let i = 0; i < value.length; i++) await render(value[i], `${field}.${i + 1}`, sections)
    } else if (value && typeof value === 'object') {
      if (!Object.keys(value).length) sections.push(`- ${field}：{}`)
      for (const [name, item] of Object.entries(value)) await render(item, field ? `${field}.${name}` : name, sections)
    } else sections.push(typeof value === 'string' && value.includes('\n') ? `\n## ${field}\n\n${value}\n` : `- ${field}：${value ?? 'null'}`)
  }
  const reviewReadings = []
  for (const packet of loaded) {
    const sections = [`# 第${packet.chapter}章复核完整阅读稿\n`, '本文件包含完整正文、底本和文学判断依据；程序核对用的时间戳/目标路径等保留在结构化输入，不必重复阅读。共享依据见独立阅读文件。证据仍使用原正文路径，材料整合不代表质量通过。\n']
    sections.push(`## 当前正文全文\n\n证据原文件：${packet.value.manuscript.originalPath}\n版本：v${packet.value.manuscript.version}；正文汉字：${packet.value.manuscript.words}\n\n${await read(packet.value.manuscript.path)}\n`)
    await render(packet.value, '', sections)
    reviewReadings.push({ chapter: packet.chapter, ...await save(resolve(task, 'chapters', `${pad(packet.chapter)}-review.md`), sections.join('\n')) })
  }
  return { reviewReadings, sharedReviewReading }
}
