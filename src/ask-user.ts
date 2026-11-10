/**
 * adx-workflow: ask_user tool (port of OpenFox's ask_user logic).
 *
 * A structured question tool for plan-mode clarification:
 * - "choice"  → ui.select with 2-5 options (the OpenFox "choice" type)
 * - "confirm" → ui.confirm (yes/no)
 * - "text"    → ui.input (free-form)
 *
 * Like OpenFox's AskUserInterrupt, the agent turn pauses until the user
 * answers; the answer comes back as the tool result. A dismissed prompt
 * resolves to a skip marker so the model can proceed with best judgment.
 * In non-interactive modes (no dialog support) the tool reports the
 * question and terminates the turn so the user can answer in chat.
 */
import { Type } from 'typebox'
import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'

const SKIP_NOTE =
  '[user skipped the question] Proceed with your best judgment and note the assumption in your plan/criteria.'

export function createAskUserTool() {
  return {
    name: 'ask_user',
    label: 'Ask User',
    description:
      'Ask the user a question and pause until they answer. Use in plan mode when the goal is ' +
      'ambiguous, a prerequisite is missing, or a decision is needed before proposing criteria. ' +
      'type "choice": present 2-5 concrete options; "confirm": yes/no; "text": free-form answer. ' +
      'The turn resumes with the user\'s answer as the result; a dismissed prompt counts as a skip.',
    promptSnippet:
      'Ask the user a focused question (choice / confirm / text) and pause for the answer — use in plan mode before proposing criteria',
    parameters: Type.Object({
      question: Type.String({
        description: 'One focused question, phrased so the user can answer in one line',
      }),
      type: StringEnum(['text', 'confirm', 'choice'] as const),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description: '2-5 short option labels, required when type is "choice"',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      args: { question: string; type: 'text' | 'confirm' | 'choice'; options?: string[] },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      const ui = ctx.ui
      const q = args.question.trim()
      const text = (t: string, terminate = false) => ({
        content: [{ type: 'text' as const, text: t }],
        details: {},
        ...(terminate ? { terminate: true } : {}),
      })

      // Non-interactive mode: dialogs resolve immediately with undefined.
      // Fall back to a chat answer: report the question and end the turn.
      const noUi = (): boolean => !ui || !ui.select

      if (args.type === 'choice') {
        const options = (args.options ?? []).filter((o) => o.trim() !== '')
        if (options.length === 0) {
          return text(
            `ask_user "choice" needs 2-5 options. Question: ${q}\nRe-call with options, or use type "text".`,
            true,
          )
        }
        if (noUi()) {
          return text(
            `Question for the user (no interactive UI): ${q}\nOptions: ${options.join(' | ')}\nPlease answer in chat.`,
            true,
          )
        }
        const picked = await ui.select(q, options)
        return text(
          picked !== undefined
            ? `User chose: ${picked}`
            : SKIP_NOTE,
        )
      }

      if (args.type === 'confirm') {
        if (noUi()) {
          return text(`Question for the user (no interactive UI): ${q}\nPlease answer yes/no in chat.`, true)
        }
        const yes = await ui.confirm(q, '')
        return text(yes ? 'User answered: yes' : 'User answered: no')
      }

      // text
      if (noUi()) {
        return text(`Question for the user (no interactive UI): ${q}\nPlease answer in chat.`, true)
      }
      const answer = await ui.input(q)
      return text(answer?.trim() ? `User answered: ${answer.trim()}` : SKIP_NOTE)
    },
  }
}
