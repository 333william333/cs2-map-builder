import { addOutsideConnection } from '../roads/connector';
import type { BuildResult } from '../types';
import { applyManualWith, type Connector } from './applyManualCore';

export { MANUAL_WARNING_PREFIX } from './applyManualCore';
export type { Connector } from './applyManualCore';

/**
 * Applies the hand-made edits in `result.settings.manual` on top of `result.baseRoads` and recomputes
 * `result.playability`. Idempotent, never mutates its input, shares the heavy typed arrays.
 * `connector` is injectable for tests.
 */
export function applyManual(result: BuildResult, connector: Connector = addOutsideConnection): BuildResult {
  return applyManualWith(result, connector);
}
