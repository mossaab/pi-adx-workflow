// Link host-provided packages (typebox, @earendil-works/*) from your pi
// install into the local node_modules, so the dev commands (smoke / e2e /
// typecheck) work from a fresh clone. Pi resolves these imports to its own
// copies at runtime; this script just replicates that resolution locally.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findPiRelease } from './find-jiti.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const { version, nodeModules } = findPiRelease()
const localNm = join(repoRoot, 'node_modules')

// Packages the extension imports (host-provided by pi)
const packages = ['typebox']
const scopeDir = join(nodeModules, '@earendil-works')
if (existsSync(scopeDir)) {
  for (const name of readdirSync(scopeDir)) packages.push(`@earendil-works/${name}`)
}

let linked = 0
for (const pkg of packages) {
  const target = join(nodeModules, pkg)
  if (!existsSync(target)) {
    console.log(`skip (not in pi install): ${pkg}`)
    continue
  }
  const link = join(localNm, pkg)
  mkdirSync(dirname(link), { recursive: true })

  let existing = null
  try {
    existing = lstatSync(link)
  } catch {
    /* absent */
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      if (readlinkSync(link) === target) {
        console.log(`ok (already linked): ${pkg}`)
        continue
      }
      rmSync(link)
    } else {
      // Real directory (e.g. installed by npm) — leave it in place.
      console.log(`skip (real directory present): ${pkg}`)
      continue
    }
  }
  symlinkSync(target, link, 'dir')
  linked++
  console.log(`linked: ${pkg} -> ${target}`)
}
console.log(`setup-dev: ${linked} link(s) from pi release ${version}`)
