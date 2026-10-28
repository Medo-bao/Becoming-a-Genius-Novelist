import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const runtime = Object.freeze({ cli: resolve(root, 'bin/novel.mjs'), manual: resolve(root, 'core/手册.md'),
  protocol: resolve(root, 'core/派单.md'), automation: resolve(root, 'core/自动制作.md') })
