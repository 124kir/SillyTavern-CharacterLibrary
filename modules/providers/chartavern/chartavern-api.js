// Shared CharacterTavern API utilities - used by both chartavern-provider.js and chartavern-browse.js
//
// Contains constants, fetch helpers, and text utilities for the
// character-tavern.com API.

// ========================================
// CONSTANTS
// ========================================

import { CL_HELPER_PLUGIN_BASE as CL_HELPER_CT_BASE } from '../provider-utils.js';
export { CL_HELPER_CT_BASE };

export const CT_API_BASE = 'https://character-tavern.com/api';
export const CT_SITE_BASE = 'https://character-tavern.com';
export const CT_CARDS_CDN = 'https://ct-cards.storage.character-tavern.com';

// Sort options accepted by /api/search/cards
export const CT_SORT_OPTIONS = {
    most_popular: 'Most Popular',
    trending: 'Trending',
    newest: 'Newest',
    oldest: 'Oldest',
    most_likes: 'Most Liked'
};

// ========================================
// NETWORK (shared)
// ========================================

import { fetchWithProxy, readJsonClassified } from '../provider-utils.js';
export { fetchWithProxy };

// ========================================
// AUTH - cl-helper cookie session
// ========================================

let ctSessionActive = false;

/**
 * Check if the cl-helper plugin is reachable.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkCtPluginAvailable(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

/**
 * Check if a CT session is active in cl-helper.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkCtSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-session`);
        if (!resp.ok) return false;
        const data = await resp.json();
        ctSessionActive = data?.active === true;
        return ctSessionActive;
    } catch {
        ctSessionActive = false;
        return false;
    }
}

/**
 * Store cookies in cl-helper for proxied CT requests.
 * @param {Function} apiRequest
 * @param {string} cookieString - Raw cookie header value (e.g. "session=abc123")
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function ctSetCookie(apiRequest, cookieString) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-set-cookie`, 'POST', {
            cookie: cookieString,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { ok: false, error: `Server returned ${resp.status}: ${text.substring(0, 100)}` };
        }
        const data = await resp.json();
        if (data?.ok) {
            ctSessionActive = true;
            return { ok: true };
        }
        return { ok: false, error: data?.error || 'Failed to store cookies' };
    } catch (err) {
        return { ok: false, error: err.message || 'Network error' };
    }
}

/**
 * Validate stored CT cookies by making a test request through cl-helper.
 * Clears session state if cookies are expired/invalid.
 * @param {Function} apiRequest
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function ctValidateSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-validate`);
        // Client-side failures never judged the cookie, so they are transient by construction
        if (!resp.ok) return { valid: false, transient: true, reason: 'validation request failed' };
        const data = await resp.json();
        if (!data?.valid) {
            ctSessionActive = false;
        }
        return data;
    } catch {
        ctSessionActive = false;
        return { valid: false, transient: true, reason: 'network error' };
    }
}

/**
 * Log out from CharacterTavern via cl-helper.
 * @param {Function} apiRequest
 */
export async function ctLogout(apiRequest) {
    try {
        await apiRequest(`${CL_HELPER_CT_BASE}/ct-logout`, 'POST');
    } catch { /* ignore */ }
    ctSessionActive = false;
}

/** @returns {boolean} */
export function isCtSessionActive() {
    return ctSessionActive;
}

/**
 * Richer session read: the last-known rolling expiry cl-helper snapshotted from CT's
 * Set-Cookie. Purely a stored-state read (no CT request), so it never slides the window.
 * @param {Function} apiRequest
 * @returns {Promise<{active: boolean, expires: number|null}>} expires in ms epoch
 */
export async function fetchCtSessionInfo(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-session`);
        if (!resp.ok) return { active: false, expires: null };
        const data = await resp.json();
        ctSessionActive = data?.active === true;
        return { active: ctSessionActive, expires: data?.expires ?? null };
    } catch {
        return { active: false, expires: null };
    }
}

// One /health probe per session backing ctFetch's transport choice; concurrent callers share it.
let _ctHelperProbe = null;

function ctHelperAvailable(apiRequest) {
    if (!apiRequest) return Promise.resolve(false);
    if (!_ctHelperProbe) _ctHelperProbe = checkCtPluginAvailable(apiRequest);
    return _ctHelperProbe;
}

/**
 * Fetch a CT API URL, routing through cl-helper's /ct-proxy whenever cl-helper is available.
 * @param {string} url - Full CT API URL (e.g. https://character-tavern.com/api/search/cards?...)
 * @param {Function} [apiRequest] - CoreAPI.apiRequest (required for proxied requests)
 * @returns {Promise<Response>}
 */
async function ctFetch(url, apiRequest) {
    // /ct-proxy is preferred even with NO session, not just for the cookie: ST's /proxy/ forwards
    // the browser's Accept-Encoding (modern Chrome/Firefox advertise zstd), CT's edge then answers
    // zstd, and STs node-fetch pipe can neither decompress it nor forward the Content-Encoding
    // header, so the browser receives undecodable bytes. /ct-proxy negotiates only encodings its
    // runtime can decode, so its responses always arrive readable.
    if (apiRequest && (ctSessionActive || await ctHelperAvailable(apiRequest))) {
        const path = url.replace(CT_SITE_BASE, '');
        return apiRequest(`${CL_HELPER_CT_BASE}/ct-proxy${path}`);
    }
    return fetchWithProxy(url);
}

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Search characters via /api/search/cards
 * @param {Object} opts
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for authenticated proxy
 * @returns {Promise<{hits: Array, totalHits: number, totalPages: number, page: number}>}
 */
// CT_SVELTEKIT_BRIDGE_V1 — CharacterTavern SvelteKit search compatibility.
// Decode SvelteKit devalue's flattened, indexed data table.
function decodeCtSvelteKitSearch(documentData) {
    for (const node of documentData?.nodes || []) {
        const table = node?.data;
        if (!Array.isArray(table) || !table.length) continue;
        const memo = new Map();
        function deref(index) {
            if (index === -1) return undefined;
            if (index === -2) return NaN;
            if (index === -3) return Infinity;
            if (index === -4) return -Infinity;
            if (index === -5) return -0;
            if (!Number.isInteger(index) || index < 0 || index >= table.length) return undefined;
            if (memo.has(index)) return memo.get(index);
            const item = table[index];
            if (Array.isArray(item)) {
                const arr = [];
                memo.set(index, arr);
                for (const ref of item) arr.push(deref(ref));
                return arr;
            }
            if (item !== null && typeof item === 'object') {
                const obj = Object.create(null);
                memo.set(index, obj);
                for (const [key, ref] of Object.entries(item)) obj[key] = deref(ref);
                return obj;
            }
            return item;
        }
        const root = deref(0);
        if (Array.isArray(root?.searchResults?.hits)) return root.searchResults;
    }
    throw new Error('CharacterTavern changed its SvelteKit search response; adapter could not find searchResults');
}

/** Search the new CharacterTavern site using /search/cards/__data.json.
 * Tag and sort support must be tested separately on the live site.
 */
export async function searchCards(opts = {}, apiRequest) {
    const {
        query = '', sort = 'most_popular', page = 1,
        tags = '', excludeTags = '', minimumTokens, maximumTokens,
        hasLorebook, isOC, nsfw = true,
    } = opts;
    const params = new URLSearchParams();
    params.set('query', query);
    // Only "best" has been confirmed. Trending currently aliases best.
    const sortMap = { most_popular: 'best', trending: 'best', newest: 'newest', oldest: 'oldest', most_likes: 'most_likes' };
    params.set('sort', sortMap[sort] || sort || 'best');
    params.set('page', String(page));
    if (tags) params.set('tags', tags);
    const excluded = excludeTags ? excludeTags.split(',').map(x => x.trim()).filter(Boolean) : [];
    if (!nsfw && !excluded.includes('nsfw')) excluded.push('nsfw');
    if (excluded.length) params.set('exclude_tags', excluded.join(','));
    if (minimumTokens != null) params.set('minimum_tokens', String(minimumTokens));
    if (maximumTokens != null) params.set('maximum_tokens', String(maximumTokens));
    if (hasLorebook != null) params.set('hasLorebook', String(hasLorebook));
    if (isOC != null) params.set('isOC', String(isOC));
    params.set('x-sveltekit-invalidated', '001');

    const url = CT_SITE_BASE + '/search/cards/__data.json?' + params;
    const resp = await ctFetch(url, apiRequest);
    if (!resp.ok) throw new Error('CharacterTavern SvelteKit search returned HTTP ' + resp.status);
    const result = decodeCtSvelteKitSearch(await resp.json());
    const hits = result.hits.map(hit => ({
        ...hit,
        totalTokens: hit.totalTokens ?? hit.permanentTokens ?? 0,
        pageDescription: hit.pageDescription ?? hit.tagline ?? '',
        isNSFW: hit.isNSFW === true || (Array.isArray(hit.contentWarnings) && hit.contentWarnings.length > 0),
    }));
    return {
        hits,
        totalHits: result.totalHits ?? hits.length,
        hitsPerPage: result.hitsPerPage ?? hits.length,
        page: result.page ?? page,
        totalPages: result.totalPages ?? 1,
        query: result.query ?? query,
    };
}

/**
 * Fetch full character details via /api/character/{author}/{slug}
 * @param {string} author
 * @param {string} slug
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for authenticated proxy
 * @returns {Promise<Object>} { card: {...}, ownerCTId: ... }
 */
// CT_PNG_DETAILS_BRIDGE_V2: full downloadable CharacterTavern PNG embeds CCv3 metadata.
function decodeCtCardPngV2(buffer) {
    const bytes = new Uint8Array(buffer);
    const sig = [137,80,78,71,13,10,26,10];
    if (bytes.length < 12 || sig.some((b,i) => bytes[i] !== b)) {
        throw new Error('CharacterTavern did not return a PNG card');
    }
    const dataView = new DataView(buffer);
    const decoder = new TextDecoder();
    const texts = new Map();
    let sawCompressed = false;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const len = dataView.getUint32(offset, false);
        const begin = offset + 8;
        const end = begin + len;
        if (end + 4 > bytes.length || end < begin) throw new Error('Invalid PNG chunk length');
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        const content = bytes.subarray(begin, end);
        if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
            const zero = content.indexOf(0);
            if (zero > 0) {
                const key = decoder.decode(content.subarray(0, zero)).toLowerCase();
                if (key === 'ccv3' || key === 'chara') {
                    if (type === 'tEXt') {
                        texts.set(key, decoder.decode(content.subarray(zero + 1)));
                    } else if (type === 'zTXt') {
                        sawCompressed = true;
                    } else {
                        // iTXt: keyword\0 flag method language\0 translated-key\0 text
                        let p = zero + 3;
                        const langEnd = content.indexOf(0, p);
                        if (langEnd >= 0) {
                            p = langEnd + 1;
                            const translatedEnd = content.indexOf(0, p);
                            if (translatedEnd >= 0) {
                                p = translatedEnd + 1;
                                if (content[zero + 1] === 0) texts.set(key, decoder.decode(content.subarray(p)));
                                else sawCompressed = true;
                            }
                        }
                    }
                }
            }
        }
        offset = end + 4;
        if (type === 'IEND') break;
    }
    const payload = texts.get('ccv3') || texts.get('chara');
    if (!payload) {
        throw new Error(sawCompressed
            ? 'PNG metadata is compressed; check that the URL includes ?action=download'
            : 'The downloaded PNG has no embedded CCv3/chara metadata');
    }
    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch (_) {
        try {
            const binary = atob(payload.trim().replace(/\s/g, ''));
            const utf8 = Uint8Array.from(binary, ch => ch.charCodeAt(0));
            parsed = JSON.parse(decoder.decode(utf8));
        } catch (error) {
            throw new Error('Invalid JSON metadata inside CharacterTavern PNG');
        }
    }
    const raw = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    if (!raw || typeof raw !== 'object' || !('name' in raw)) {
        throw new Error('Downloaded PNG does not contain a recognizable character card');
    }
    const data = {
        ...raw,
        name: raw.name || '',
        description: raw.description || '',
        personality: raw.personality || '',
        scenario: raw.scenario || '',
        first_mes: raw.first_mes || '',
        mes_example: raw.mes_example || '',
        system_prompt: raw.system_prompt || '',
        post_history_instructions: raw.post_history_instructions || '',
        creator_notes: raw.creator_notes || '',
        creator: raw.creator || '',
        character_version: raw.character_version || '',
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        alternate_greetings: Array.isArray(raw.alternate_greetings) ? raw.alternate_greetings : [],
        extensions: raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {},
    };
    return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

/** Downloads complete card data from the canonical PNG and adapts it for the UI. */
export async function fetchCharacterDetail(author, slug, _apiRequest) {
    const path = author + '/' + slug;
    const url = getCardPngUrl(path);
    const response = await fetchWithProxy(url);
    if (!response.ok) throw new Error('Card PNG download failed: HTTP ' + response.status);
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().includes('image/png') &&
        !contentType.toLowerCase().includes('application/octet-stream')) {
        throw new Error('CharacterTavern returned ' + contentType + ', not a PNG');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 20 * 1024 * 1024) throw new Error('Character PNG exceeds 20 MB');
    const embedded = decodeCtCardPngV2(buffer);
    const d = embedded.data;
    return {
        card: {
            id: d.extensions?.chartavern?.id || null,
            path,
            name: d.name,
            inChatName: d.name,
            author: d.creator || author,
            description: d.creator_notes,
            tagline: d.creator_notes,
            tags: d.tags,
            definition_character_description: d.description,
            definition_first_message: d.first_mes,
            definition_example_messages: d.mes_example,
            definition_personality: d.personality,
            definition_scenario: d.scenario,
            definition_system_prompt: d.system_prompt,
            definition_post_history_prompt: d.post_history_instructions,
            alternativeFirstMessage: d.alternate_greetings,
        },
        _embeddedCard: embedded,
    };
}

/**
 * Fetch top tags from /api/catalog/top-tags
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for the cl-helper transport
 * @returns {Promise<Array<{tag: string, count: number}>>}
 */
export async function fetchTopTags(apiRequest) {
    const url = `${CT_API_BASE}/catalog/top-tags`;
    const resp = await ctFetch(url, apiRequest);
    if (!resp.ok) throw new Error(`Top tags fetch failed (${resp.status})`);
    return resp.json();
}

// ========================================
// URL / PATH HELPERS
// ========================================

/**
 * Card image URL. CT moved cards to the storage host and dropped the /cdn-cgi/image resize (404s there now), so this serves the full image direct; browsers get webp via content negotiation.
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getAvatarUrl(path) {
    return `${CT_CARDS_CDN}/${path}.png`;
}

/**
 * Build full-size card PNG URL (for download / import).
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCardPngUrl(path) {
    return `${CT_CARDS_CDN}/${path.split('/').map(encodeURIComponent).join('/')}.png?action=download`;
}

/**
 * Build the web page URL for a character.
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCharacterPageUrl(path) {
    return `${CT_SITE_BASE}/character/${path}`;
}

/**
 * Parse a character-tavern.com URL into author/slug path.
 * Accepts: https://character-tavern.com/character/author/slug
 * @param {string} url
 * @returns {string|null} "author/slug" or null
 */
export function parseCharacterUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        if (!/^(www\.)?character-tavern\.com$/i.test(u.hostname)) return null;
        const match = u.pathname.match(/^\/character\/([^/]+)\/([^/]+)/);
        if (match) return `${match[1]}/${match[2]}`;
    } catch { /* ignore */ }
    return null;
}

// ========================================
// TEXT UTILITIES (shared + local)
// ========================================

export { slugify, stripHtml, formatNumber } from '../provider-utils.js';

/**
 * The clean character name. CT's `name` is the listing title ("Shy Cousin") while `inChatName`
 * carries the plain name ("Elara"), the same split Wyvern and JanitorAI have. Nullable, and real
 * data carries trailing spaces, so trim. Both search hits and the detail card have both fields.
 * @param {Object} apiData - CT card object (detail card or search hit)
 * @returns {string}
 */
export function getCtCharName(apiData) {
    return (apiData?.inChatName || '').trim() || apiData?.name || 'Unknown';
}

/**
 * Normalize tags into an array of strings.
 * CT API returns tags as an array; handles legacy space-separated strings too.
 */
export function parseTags(tags) {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags.filter(Boolean);
    if (typeof tags === 'string') return tags.split(/\s+/).filter(Boolean);
    return [];
}
