/**
 * adx-workflow: template variables.
 *
 * Template resolution (resolveTemplate) + executor helpers
 * (formatCriteriaList / formatModifiedFiles).
 */

import { execFileSync } from 'node:child_process'

export interface TemplateContext {
  workdir: string
  reason: string
  /** @deprecated Use stepOutput.content instead */
  verifierFindings: string
  /** @deprecated Use stepOutput.stdout instead */
  previousStepOutput: string
  criteriaCount: number
  pendingCount: number
  criteriaList: string
  modifiedFiles: string
  stepOutput: Record<string, string>
  /** User-supplied parameters from workflow launch (e.g. /adx-build args) */
  params: Record<string, string>
}

const BUILT_IN_NAMES = [
  'workdir',
  'reason',
  'criteriaCount',
  'pendingCount',
  'criteriaList',
  'modifiedFiles',
] as const

/**
 * Format the criteria list with status markers:
 * formatCriteriaList: [PASSED], [NEEDS VERIFICATION], [FAILED], [NOT COMPLETED].
 */
export function formatCriteriaList(
  entries: Array<{ id: string; description: string; status?: string; [k: string]: unknown }>,
): string {
  if (entries.length === 0) return '(none)'
  return entries
    .map((e) => {
      const status =
        e.status === 'passed'
          ? '[PASSED]'
          : e.status === 'completed'
            ? '[NEEDS VERIFICATION]'
            : e.status === 'failed'
              ? '[FAILED]'
              : '[NOT COMPLETED]'
      return `- **${e.id}** ${status}: ${e.description}`
    })
    .join('\n')
}

/** List of files modified in the working tree (git diff, staged + unstaged). */
export function getModifiedFiles(workdir: string): string {
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
    return out || '(no modifications)'
  } catch {
    return '(not a git repository)'
  }
}

export function resolveTemplate(template: string, ctx: TemplateContext): string {
  let result = template
  // Resolve built-in variables first
  for (const name of BUILT_IN_NAMES) {
    const value = String(ctx[name])
    result = result.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), value)
  }
  // Flat dotted keys: {{stepOutput.<key>}}
  result = result.replace(/\{\{stepOutput\.([\w.-]+)\}\}/g, (_, key) => ctx.stepOutput[key] ?? '')
  // Deprecated aliases
  result = result.replace(/\{\{verifierFindings\}\}/g, ctx.stepOutput['content'] ?? '')
  result = result.replace(/\{\{previousStepOutput\}\}/g, ctx.stepOutput['stdout'] ?? '')
  // Resolve user-supplied params (lower priority — can't override built-ins)
  for (const [key, value] of Object.entries(ctx.params)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  return result
}
