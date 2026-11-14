// Forge-wide constants.
//
// The viewer login is FIXED by the suite: program/env/src/wire.ts builds its scenario from the
// constant SCENARIO_SEED (0x6a09e667f3bcc909) with no inputs, and the viewer's login is the first
// generated user, "adaiversen" (id 1000). Verified by running the kit's own buildScenario().
// Every check addresses the viewer by that login; any other owner is a 404, never a 403.

/** The token owner's login (the scenario viewer). */
export const VIEWER_LOGIN = 'adaiversen';
/** The token owner's numeric user id (the scenario viewer's id). */
export const VIEWER_ID = 1000;
/** The token owner's display name / email (the scenario viewer's). */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The default branch every new repository gets. */
export const DEFAULT_BRANCH = 'main';

/**
 * The one timestamp the forge ever stamps: commits the forge itself creates (contents PUTs,
 * merges) and every created_at/updated_at/merged_at in REST answers. Fixed, never the clock,
 * so two runs of a trial produce identical bytes.
 */
export const FIXED_EPOCH_SEC = 1700000000;
/** FIXED_EPOCH_SEC as an ISO-8601 string (GitHub's created_at shape). */
export const FIXED_ISO = '2023-11-14T22:13:20.000Z';
/** The identity line commits the forge creates carry. */
export const FORGE_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

/** The all-zero object id: an unborn branch's old/new value. */
export const ZERO_OID = '0'.repeat(40);
