/**
 * Locate a pi release install (and the jiti loader inside it).
 *
 * Scans ~/.pi/agent/install/releases/<release>/node_modules and picks the
 * newest release. Override with ADX_FLOW_JITI (absolute path to a jiti module
 * directory; its parent is taken as the node_modules dir).
 *
 * @returns {{ version: string, nodeModules: string, jiti: string }}
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function findPiRelease() {
  const override = process.env.ADX_FLOW_JITI
  if (override) {
    return {
      version: 'ADX_FLOW_JITI',
      nodeModules: dirname(override),
      jiti: override,
    }
  }

  const releasesDir = join(homedir(), '.pi', 'agent', 'install', 'releases')
  const versions = existsSync(releasesDir)
    ? readdirSync(releasesDir).filter((v) =>
        existsSync(join(releasesDir, v, 'node_modules', 'jiti')),
      )
    : []

  if (versions.length === 0) {
    console.error(
      [
        `FAIL: jiti not found (looked in ${releasesDir}/<release>/node_modules/jiti).`,
        '  pi-coding-agent must be installed — see README → Requirements.',
        '  Override the lookup with ADX_FLOW_JITI=/path/to/node_modules/jiti.',
      ].join('\n'),
    )
    process.exit(1)
  }

  // Sort semver-ish: "1.5.10" > "1.5.2"
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  }
  versions.sort(cmp)
  const version = versions.at(-1)
  const nodeModules = join(releasesDir, version, 'node_modules')
  return { version, nodeModules, jiti: join(nodeModules, 'jiti') }
}

/**
 * Resolve `createJiti` from the pi release (the loader pi uses for extensions).
 * @returns {(entry: string, opts?: object) => any}
 */
export function createJitiFromPi() {
  const { version, jiti } = findPiRelease()
  console.log(`using jiti from pi release ${version}`)
  return createRequire(join(jiti, 'noop.js'))('jiti').createJiti
}
