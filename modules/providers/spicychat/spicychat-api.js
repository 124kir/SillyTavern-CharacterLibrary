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


// Public detail endpoint is independent from Typesense. Do not send site cookies or
// authentication tokens: closed character definitions remain unavailable.
const SPICY_DETAIL_BASE = 'https://prod.nd-api.com/v2/characters/';
const detailCache = new Map();
const GUEST_ID = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID() : null;

export async function fetchSpicyDetail(id, { refresh = false } = {}) {
    const safeId = String(id || '').trim();
    if (!/^[a-z0-9_-]{4,128}$/i.test(safeId)) throw new Error('Invalid SpicyChat character ID');
    if (!refresh && detailCache.has(safeId)) return detailCache.get(safeId);
    // Mandatory SpicyChat application identity header for the public detail API.
    // This is a public app identifier, not a credential.
    const options = { headers: {
        'X-App-Id': 'spicychat',
        'X-Country': 'US',
        Accept: 'application/json',
        'Cache-Control': 'no-transform',
    } };
    if (GUEST_ID) options.headers['X-Guest-UserId'] = GUEST_ID;
    // Cache only a successful public response. Failed requests remain retryable.
    const promise = (async () => {
        const response = await fetchWithProxy(SPICY_DETAIL_BASE + encodeURIComponent(safeId), options);
        if (!response.ok) throw new Error('SpicyChat character detail HTTP ' + response.status);
        const payload = await response.json();
        const raw = payload?.character && typeof payload.character === 'object' ? payload.character : payload;
        if (!raw || typeof raw !== 'object') throw new Error('SpicyChat detail has an invalid format');
        if (raw.visibility && raw.visibility !== 'public') throw new Error('This character is not publicly visible');
        const returnedId = String(raw.character_id || raw.id || safeId);
        if (returnedId !== safeId) throw new Error('SpicyChat returned an unexpected character ID');
        return raw;
    })().catch(error => { detailCache.delete(safeId); throw error; });
    detailCache.set(safeId, promise);
    return promise;
}

// Do not conflate publicly readable introduction text with the creator's hidden definition.
function textValue(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n');
    return textValue(value.text || value.content || value.message || value.value || value.prologue || value.greeting);
}

export function parseSpicyDetail(raw, hit = {}) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid public SpicyChat detail');
    const publicDefinition = raw.definition_visible === true;
    const rawGreetings = [raw.greeting, ...(Array.isArray(raw.alternate_greetings) ? raw.alternate_greetings : []),
        ...(Array.isArray(raw.greetings) ? raw.greetings : [])];
    const greetings = [...new Set(rawGreetings.flatMap(v => Array.isArray(v) ? v.map(textValue) : [textValue(v)]).filter(Boolean))];
    const examplesRaw = raw.example_dialogue || raw.exampleConversation || raw.exampleMessages || raw.conversation_examples || raw.dialogue || '';
    const examples = Array.isArray(examplesRaw)
        ? examplesRaw.map(item => {
            if (typeof item === 'string') return item;
            const role = String(item?.role || item?.speaker || '').toLowerCase();
            const speaker = role === 'assistant' || role === 'character' ? '{{char}}' : '{{user}}';
            const content = textValue(item);
            return content ? speaker + ': ' + content : '';
        }).filter(Boolean).join('\n')
        : textValue(examplesRaw);
    const privateDefinition = publicDefinition
        ? textValue(raw.definition || raw.persona || raw.character_definition || raw.characterDefinition || raw.personality)
        : '';
    return {
        id: String(raw.character_id || raw.id || hit.id || ''),
        name: textValue(raw.name) || hit.name || 'Unnamed',
        creator: textValue(raw.creator_username || raw.creator) || hit.creator || '',
        tagline: textValue(raw.title || raw.description) || hit.title || '',
        avatar: hit.avatar || normalizeSpicyHit(raw)?.avatar || '',
        tags: Array.isArray(raw.tags) ? raw.tags.filter(x => typeof x === 'string').slice(0, 100) : (hit.tags || []),
        isNsfw: raw.is_nsfw === true || raw.avatar_is_nsfw === true || hit.isNsfw === true,
        messages: Number(raw.num_messages) || hit.messages || 0,
        definitionVisible: publicDefinition,
        description: privateDefinition,
        personality: publicDefinition ? textValue(raw.personality) : '',
        scenario: publicDefinition ? textValue(raw.scenario) : '',
        firstMessage: greetings[0] || '',
        alternateGreetings: greetings.slice(1),
        examples: publicDefinition ? examples : '',
        systemPrompt: publicDefinition ? textValue(raw.system_prompt) : '',
        postHistory: publicDefinition ? textValue(raw.post_history_instructions) : '',
        url: hit.url || ('https://spicychat.ai/chatbot/' + encodeURIComponent(String(raw.character_id || raw.id || ''))),
    };
}

export function isSpicyImportable(detail) {
    // Fail closed if the author did not explicitly publish the definition or if the
    // resulting card would have no character definition and no greeting.
    return detail?.definitionVisible === true
        && !!(detail?.description || detail?.personality)
        && !!detail?.firstMessage;
}
