import { lstat } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join, sep } from 'node:path'

export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path))
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

/** 写入与任务产物使用真实目录边界；显式选定的外部只读资料不经过此入口。 */
export async function safePath(root, path) {
  const base = resolve(root), full = resolve(base, path)
  if (!inside(base, full)) throw new Error('文件路径超出项目或任务目录')
  let current = base
  for (const part of relative(base, full).split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try { info = await lstat(current) } catch (error) { if (error.code === 'ENOENT') break; throw error }
    if (info.isSymbolicLink()) throw new Error(`受控文件路径不允许符号链接或目录联接：${current}`)
  }
  return full
}

/** 保留作者显式配置的外部受管目录；根内目录仍检查完整祖先链。 */
export async function managedPath(root, directory, path) {
  const base = resolve(root, directory)
  if (inside(root, base)) await safePath(root, base)
  return safePath(base, path)
}
