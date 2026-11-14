// Experimental SpicyChat public character discovery.
// No login/session cookies, no import of hidden definitions, no hardcoded API key.
import { fetchWithProxy } from '../provider-utils.js';

const SETTINGS_URL = 'https://4mpanjbsf6.execute-api.us-east-1.amazonaws.com/v2/applications/spicychat';
const TYPESENSE_URL = 'https://etmzpxgvnid370fyp.a1.typesense.net/multi_search';
let searchKeyPromise = null;

async function publicSearchKey() {
    if (!searchKeyPromise) {
        searchKeyPromise = (async () => {
            // The site advertises the public CHARACTER SEARCH key in its app config.
            // An anonymous GET may be refused on some deployments: surface that error,
            // do not try to obtain a user's session or bypass authorization.
            const response = await fetchWithProxy(SETTINGS_URL, { headers: { Accept: 'application/json' } });
            const payload = await response.json();
            const key = payload?.typesenseConfig?.apiKeyPublicCharacter;
            if (typeof key !== 'string' || !key.trim()) {
                throw new Error('SpicyChat does not expose an anonymous public-search key. Open the site to browse instead.');
            }
            return key.trim();
        })().catch(error => {
            searchKeyPromise = null;
            throw error;
        });
    }
    return searchKeyPromise;
}

export function normalizeSpicyHit(hit) {
    const doc = hit?.document || hit || {};
    const id = String(doc.id || doc.character_id || '').trim();
    if (!/^[a-z0-9_-]{4,128}$/i.test(id)) return null;
    return {
        id,
        name: String(doc.name || doc.title || 'Unnamed').slice(0, 150),
        title: String(doc.title || '').slice(0, 400),
        creator: String(doc.creator_username || '').slice(0, 100),
        avatar: typeof doc.avatar_url === 'string' && /^https:\/\//i.test(doc.avatar_url) ? doc.avatar_url : '',
        tags: Array.isArray(doc.tags) ? doc.tags.filter(x => typeof x === 'string').slice(0, 12) : [],
        isNsfw: doc.is_nsfw === true,
        definitionVisible: doc.definition_visible === true,
        messages: Number.isFinite(Number(doc.num_messages)) ? Number(doc.num_messages) : 0,
        url: 'https://spicychat.ai/chatbot/' + encodeURIComponent(id),
    };
}

export async function searchSpicyCharacters({ query = '', page = 1, perPage = 24, nsfw = false, sort = 'popular' } = {}) {
    const apiKey = await publicSearchKey();
    const safePage = Math.min(100, Math.max(1, Number(page) || 1));
    const safePerPage = Math.min(48, Math.max(1, Number(perPage) || 24));
    const sortBy = sort === 'newest' ? 'createdAt:desc' : 'num_messages_24h:desc';
    const body = {
        searches: [{
            collection: 'public_characters_alias',
            q: String(query || '').slice(0, 140) || '*',
            query_by: 'name,title,tags,creator_username,character_id',
            page: safePage,
            per_page: safePerPage,
            sort_by: sortBy,
            // Conservative default: never request NSFW characters without explicit opt-in.
            ...(!nsfw ? { filter_by: 'is_nsfw:=false' } : {}),
        }],
    };
    const response = await fetchWithProxy(TYPESENSE_URL, {
        method: 'POST',
        headers: { 'x-typesense-api-key': apiKey, 'content-type': 'text/plain', Accept: 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json();
    const result = payload?.results?.[0];
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
