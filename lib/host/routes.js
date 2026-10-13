/**
 * Host-side HTTP routes.
 *
 * The exact same handler serves two callers: the standalone offline recovery
 * process, and the DSH host plugin (which mounts it on `/dsh-version-guard`).
 * One implementation means the offline page and the in-DSH settings page can
 * never disagree about what a button does.
 *
 * The route prefix must be final and exact: any request the guard does not
 * recognise is forwarded to DSH's own web server, so the guard never breaks the
 * UI it is embedded in.
 */

import { RECOVERY_HTML } from '../recovery/page.js'
import { createRecoveryHandler } from '../recovery/server.js'

/** Fixed route prefix. Must not be a prefix of any DSH route. */
export const ROUTE_PREFIX = '/dsh-version-guard'

/**
 * Build the request handler for the guard's own routes.
 *
 * The full recovery page is served here, so the same UI is available inside DSH
 * and standalone.
 *
 * @param {{
 *   serviceFor: (profileName: string | null) => any,
 *   listProfiles: () => unknown[],
 *   base?: string,
 *   logger?: { info?: Function, warn?: Function },
 * }} options
 *   `base` is the mount prefix already present on the request URL. It defaults
 *   to {@link ROUTE_PREFIX} because mounting under DSH is the common case; pass
 *   `''` when the guard owns its own port.
 */
export function createGuardHandler(options) {
  return createRecoveryHandler({
    serviceFor: options.serviceFor,
    listProfiles: options.listProfiles,
    // The full recovery UI, so the same page works in-DSH and standalone. It is
    // handed the mount prefix so its own fetches resolve back through here.
    html: RECOVERY_HTML,
    base: options.base ?? ROUTE_PREFIX,
    inDsh: true,
    log: (line) => options.logger?.info?.(line),
  })
}

/**
 * Mount the guard onto a DSH web server.
 *
 * `prefix` means only `ROUTE_PREFIX` and everything under it reaches us, and
 * longest-prefix-wins keeps a more specific DSH route in control of its own
 * paths. The handler does the prefix stripping, so the original request object
 * is passed through untouched.
 *
 * @param {{ webServer: { register: (route: { kind: string, path: string, handler: Function }) => Function }, serviceFor: Function, listProfiles: Function, logger?: any }} input
 * @returns {() => void} disposer
 */
export function mountGuardRoutes(input) {
  const handler = createGuardHandler({
    serviceFor: input.serviceFor,
    listProfiles: input.listProfiles,
    logger: input.logger,
  })
  const dispose = input.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => handler(request, response),
  })
  return typeof dispose === 'function' ? dispose : () => {}
}
