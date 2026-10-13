/**
 * Error helpers shared by every entry point (DSH host plugin, recovery server,
 * CLI). Errors are codes, not prose: the callers own the localized text, so the
 * same failure reads correctly in the settings page and in the offline page.
 */

/** Error carrying a stable machine code and optional detail payload. */
export class VersionGuardError extends Error {
  /**
   * @param {string} code Stable machine code, e.g. `profile/not-found`.
   * @param {string} message English fallback message (developers only).
   * @param {Record<string, unknown>} [detail] Extra structured context.
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'VersionGuardError'
    this.code = code
    this.detail = detail ?? {}
  }
}

/**
 * Convert any thrown value into a serializable `{ code, message, detail }`.
 * @param {unknown} error
 * @returns {{ code: string, message: string, detail: Record<string, unknown> }}
 */
export function toErrorPayload(error) {
  if (error instanceof VersionGuardError) {
    return { code: error.code, message: error.message, detail: error.detail }
  }
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? error.code : 'unexpected'
    return { code, message: error.message, detail: {} }
  }
  return { code: 'unexpected', message: String(error), detail: {} }
}

/**
 * Run `fn`, converting a throw into the `{ ok: false, error }` result shape the
 * HTTP layer and the settings page both consume.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: ReturnType<typeof toErrorPayload> }>}
 */
export async function attempt(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: toErrorPayload(error) }
  }
}
