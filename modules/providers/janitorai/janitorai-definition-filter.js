// Strict JanitorAI definition filtering. Listing rows cannot be trusted to tell whether
// a character's definition is public (their showdefinition field is always false).
// Only a successful detail response can classify one as public or hidden.
const visibilityCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const STOP_CODES = new Set([
    'HAMPTER_RATE_LIMITED', 'HAMPTER_LOGIN_REQUIRED', 'HAMPTER_TOKEN_EXPIRED', 'HAMPTER_BLOCKED',
]);

/**
 * Return only characters with a confirmed public definition. Unreadable/failed details
 * remain UNKNOWN (not hidden) and are excluded from strict-mode results.
 *
 * @param {Object[]} hits - normalised JanitorAI listing rows
 * @param {Object} opts
 * @param {(id:string,opts:Object)=>Promise<Object|null>} opts.fetchDetail
 * @param {(detail:Object)=>boolean} opts.isHidden
 * @param {AbortSignal} [opts.signal]
 * @param {Map} [opts.cache] - injectable for tests
 * @param {()=>number} [opts.now] - injectable for tests
 * @param {number} [opts.concurrency] - max simultaneous detail fetches
 * @returns {Promise<{characters:Object[],hidden:number,unknown:number,blockedCode:string}>}
 */
export async function filterPublicJanitoraiDefinitions(hits, {
    fetchDetail, isHidden, signal, cache = visibilityCache, now = Date.now, concurrency = 2,
} = {}) {
    if (!Array.isArray(hits) || !hits.length) {
        return { characters: [], hidden: 0, unknown: 0, blockedCode: '' };
    }
    if (typeof fetchDetail !== 'function' || typeof isHidden !== 'function') {
        throw new TypeError('Definition filter requires fetchDetail and isHidden');
    }

    // null means unknown; false means confirmed hidden; true means confirmed public.
    const visibility = new Array(hits.length).fill(null);
    let cursor = 0;
    let blockedCode = '';

    async function worker() {
        while (cursor < hits.length && !blockedCode && !signal?.aborted) {
            const index = cursor++;
            const id = String(hits[index]?.character_id || hits[index]?.id || '');
            if (!id) continue;

            const saved = cache.get(id);
            if (saved && saved.expiresAt > now()) {
                visibility[index] = saved.public;
                continue;
            }
            if (saved) cache.delete(id);

            try {
                const detail = await fetchDetail(id, { signal });
                if (!detail || signal?.aborted) continue;
                const isPublic = !isHidden(detail);
                visibility[index] = isPublic;
                cache.delete(id);
                cache.set(id, { public: isPublic, expiresAt: now() + CACHE_TTL_MS });
                if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
            } catch (err) {
                // A failed check must never be mislabeled as a public or hidden definition.
                if (signal?.aborted || err?.name === 'AbortError') return;
                if (STOP_CODES.has(err?.code)) blockedCode = err.code;
            }
        }
    }

    const workerCount = Math.min(hits.length, Math.max(1, Math.min(3, Math.floor(concurrency) || 2)));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return {
        characters: hits.filter((_, index) => visibility[index] === true),
        hidden: visibility.filter(value => value === false).length,
        unknown: visibility.filter(value => value === null).length,
        blockedCode,
    };
}
