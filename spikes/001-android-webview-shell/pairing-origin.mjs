// Retain the spike entrypoint for the Android bootstrap and existing tests.
// The Web API also imports this one strict normalizer; do not fork its policy.
export { normalizeTrustedLanHttpOrigin } from '../../apps/web/src/api/trusted-lan-origin.mjs';
