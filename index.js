/**
 * dsh-ui-beautify — Host half.
 *
 * This plugin is UI-only: the visible work happens in `client.js` through the
 * Client theme service and the settings slot. The Host half intentionally does
 * nothing, so the bundle has no server routes, no tools, and no configuration.
 *
 * Contract notes:
 *   - Export `apply(ctx, config)` or a default service class; never both.
 *   - Every registration lives in `apply` and returns its cleanup.
 *   - No logger writes here: there is nothing to log, and user appearance
 *     preferences must not leak into logs.
 */

export const inject = []

export function apply() {
  // Intentionally empty. See client.js.
}
