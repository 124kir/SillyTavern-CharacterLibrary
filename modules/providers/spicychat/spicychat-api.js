// Experimental SpicyChat public character discovery.
// No login/session cookies, no import of hidden definitions, no hardcoded API key.
import { fetchWithProxy } from '../provider-utils.js';

const SETTINGS_URL = 'https://prod.nd-api.com/v2/applications/spicychat';
const TYPESENSE_BASE = 'https://ts-lb.nd-api.com';
let searchKeyPromise = null;

async function publicSearchKey() {
    if (!searchKeyPromise) {
        searchKeyPromise = (async () => {
            // The site advertises the public CHARACTER SEARCH key in its app config.
            // An anonymous GET may be refused on some deployments: surface that error,
            // do not try to obtain a user's session or bypass authorization.
            const response = await fetchWithProxy(SETTINGS_URL, { headers: { Accept: 'application/json' } });
            const payload = await response.json();
            const key = payload?.typesenseConfig?.apiKeyPublicCharacter || payload?.typesenseSearchKey;
            if (typeof key !== 'string' || !key.trim()) {
                throw new Error('SpicyChat does not expose an anonymous public-search key. Open the site to browse instead.');
            }
            const collection = payload?.typesenseConfig?.collectionNamePublicCharacter || 'public_characters_alias';
            if (!/^[a-zA-Z0-9_-]{1,100}$/.test(collection)) throw new Error('Invalid SpicyChat search collection');
            return { key: key.trim(), collection };
        })().catch(error => {
            searchKeyPromise = null;
            throw error;
        });
    }
    return searchKeyPromise;
}

export function normalizeSpicyHit(hit) {
    const doc = hit?.document || hit || {};
    const id = String(doc.character_id || doc.id || '').trim();
    if (!/^[a-z0-9_-]{4,128}$/i.test(id)) return null;
    return {
        id,
        name: String(doc.name || doc.title || 'Unnamed').slice(0, 150),
        title: String(doc.title || '').slice(0, 400),
        creator: String(doc.creator_username || '').slice(0, 100),
        avatar: (() => {
            if (typeof doc.avatar_url !== 'string' || !doc.avatar_url.trim()) return '';
            const value = doc.avatar_url.trim();
            if (/^https:\/\//i.test(value)) return value;
            const path = value.replace(/^\/+/, '').replace(/^avatars\/avatars\//i, 'avatars/');
            if (!/^[\w./%-]+$/.test(path) || path.includes('..')) return '';
            return 'https://cdn.nd-api.com/' + (path.startsWith('avatars/') ? path : 'avatars/' + path);
        })(),
        tags: Array.isArray(doc.tags) ? doc.tags.filter(x => typeof x === 'string').slice(0, 12) : [],
        isNsfw: doc.is_nsfw === true || doc.avatar_is_nsfw === true,
        definitionVisible: doc.definition_visible === true,
        messages: Number.isFinite(Number(doc.num_messages)) ? Number(doc.num_messages) : 0,
        url: 'https://spicychat.ai/chatbot/' + encodeURIComponent(id),
    };
}

export async function searchSpicyCharacters({ query = '', page = 1, perPage = 24, nsfw = false, sort = 'popular' } = {}) {
    const config = await publicSearchKey();
    const safePage = Math.min(100, Math.max(1, Number(page) || 1));
    const safePerPage = Math.min(48, Math.max(1, Number(perPage) || 24));
    const sortBy = sort === 'newest' ? 'createdAt:desc' : 'num_messages_24h:desc';
    // GET requests are supported by SillyTavern's generic proxy more reliably than JSON POST.
    const params = new URLSearchParams({
        q: String(query || '').slice(0, 140).trim() || '*',
        query_by: 'name,title,tags,creator_username',
        sort_by: sortBy,
        page: String(safePage),
        per_page: String(safePerPage),
        use_cache: 'true',
    });
    const filters = ['type:!=META', 'visibility:=public', 'application_ids:=spicychat'];
    if (!nsfw) filters.push('is_nsfw:false', 'avatar_is_nsfw:false');
    params.set('filter_by', filters.join('&&'));
    const url = TYPESENSE_BASE + '/collections/' + encodeURIComponent(config.collection) + '/documents/search?' + params;
    let response;
    try {
        response = await fetchWithProxy(url, {
            headers: { 'X-TYPESENSE-API-KEY': config.key, Accept: 'application/json', 'Cache-Control': 'no-transform' },
        });
    } catch (error) {
        searchKeyPromise = null;
        throw new Error('SpicyChat search failed: ' + (error?.message || 'network error'));
    }
    if (!response.ok) { searchKeyPromise = null; throw new Error('SpicyChat search HTTP ' + response.status); }
    const result = await response.json();
    if (!result || !Array.isArray(result.hits)) {
        throw new Error('SpicyChat returned an unexpected search response');
    }
    return {
        found: Number(result.found) || 0,
        hits: result.hits.map(normalizeSpicyHit).filter(Boolean),
        page: safePage,
        perPage: safePerPage,
    };
}
