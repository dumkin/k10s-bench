// The clients under test, in the order the results list them.

import aptakube from "./aptakube.mjs";
import headlamp from "./headlamp.mjs";
import k10s from "./k10s.mjs";
import k9s from "./k9s.mjs";
import { freelens, lens } from "./lens.mjs";

export const CLIENTS = { k10s, aptakube, headlamp, freelens, lens, k9s };

/**
 * Measured unless --clients says otherwise. Lens is left out: it works only after signing in to a Lens ID, and
 * Freelens, its open source fork, is the same app underneath. `--clients lens` measures it (you sign in once).
 */
export const DEFAULT_CLIENTS = ["k10s", "aptakube", "headlamp", "freelens", "k9s"];
