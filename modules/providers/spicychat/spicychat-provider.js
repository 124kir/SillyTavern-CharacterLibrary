// SpicyChat discovery-only provider (experimental). No definition import or account access.
import { ProviderBase } from '../provider-interface.js';
import { searchSpicyCharacters } from './spicychat-api.js';

class SpicyChatProvider extends ProviderBase {
    get id() { return 'spicychat'; }
    get name() { return 'SpicyChat'; }
    get icon() { return 'fa-solid fa-pepper-hot'; }
    get beta() { return true; }
    get disabledByDefault() { return true; }
    get enableWarning() {
        return 'Experimental SpicyChat public-search adapter. The anonymous API may be unavailable. This provider only displays public search results and opens SpicyChat; it does not import character definitions.';
    }

    constructor() {
        super();
        this.page = 1;
        this.query = '';
        this.nsfw = false;
        this.sort = 'popular';
        this.generation = 0;
        this.container = null;
        this.abort = null;
    }

    getLinkInfo() { return null; }
    canHandleUrl(url) {
        try { const u = new URL(url); return u.hostname === 'spicychat.ai' && /^\/(chatbot|chat)\/[\w-]+\/?$/.test(u.pathname); }
        catch { return false; }
    }
    parseUrl(url) {
        if (!this.canHandleUrl(url)) return null;
        return new URL(url).pathname.split('/')[2] || null;
    }

    renderFilterBar() {
        return `<div class="browse-sort-container" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <input type="search" id="spicySearch" class="glass-input" aria-label="Search SpicyChat public characters" placeholder="Search SpicyChat…" maxlength="140" style="min-width:180px">
            <select id="spicySort" class="glass-select" aria-label="SpicyChat sorting"><option value="popular">Trending</option><option value="newest">Newest</option></select>
            <label style="display:flex;align-items:center;gap:5px"><input id="spicyNsfw" type="checkbox">NSFW</label>
            <button id="spicySubmit" type="button" class="glass-btn">Search</button>
        </div>`;
    }

    renderView() {
        return `<section class="spicy-discovery">
            <p style="padding:12px 16px;opacity:.8">Experimental public character discovery. No account login or hidden-definition import. <a target="_blank" rel="noopener noreferrer" href="https://spicychat.ai/">Open SpicyChat</a></p>
            <div id="spicyStatus" role="status" aria-live="polite" style="padding:8px 16px"></div>
            <div id="spicyGrid" class="browse-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:14px;padding:16px"></div>
            <div style="display:flex;justify-content:center;padding:12px"><button id="spicyMore" class="glass-btn" type="button" hidden>More results</button></div>
        </section>`;
    }

    async activate(container) {
        this.container = container;
        const q = document.getElementById('spicySearch');
        const sort = document.getElementById('spicySort');
        const nsfw = document.getElementById('spicyNsfw');
        const go = document.getElementById('spicySubmit');
        const more = container.querySelector('#spicyMore');
        if (q) q.value = this.query;
        if (sort) sort.value = this.sort;
        if (nsfw) nsfw.checked = this.nsfw;
        if (q) q.onkeydown = e => { if (e.key === 'Enter') this.startSearch(); };
        if (go) go.onclick = () => this.startSearch();
        if (more) more.onclick = () => this.runSearch(false);
        // Do not make requests merely by enabling the experimental provider.
        this.setStatus('Type a query and press Search to browse public characters.');
    }

    deactivate() {
        this.generation++;
        this.abort?.abort();
        this.container = null;
    }

    setStatus(message) {
        const el = this.container?.querySelector('#spicyStatus');
        if (el) el.textContent = message;
    }

    startSearch() {
        this.query = document.getElementById('spicySearch')?.value?.trim() || '';
        this.sort = document.getElementById('spicySort')?.value || 'popular';
        this.nsfw = document.getElementById('spicyNsfw')?.checked === true;
        this.page = 1;
        this.runSearch(true);
    }

    async runSearch(reset) {
        if (!this.container) return;
        const gen = ++this.generation;
        this.abort?.abort();
        const root = this.container;
        const grid = root.querySelector('#spicyGrid');
        const more = root.querySelector('#spicyMore');
        if (!grid) return;
        if (reset) grid.replaceChildren();
        if (more) more.hidden = true;
        this.setStatus('Searching SpicyChat…');
        try {
            const result = await searchSpicyCharacters({
                query: this.query, page: this.page, perPage: 24,
                nsfw: this.nsfw, sort: this.sort,
            });
            if (gen !== this.generation || root !== this.container) return;
            for (const hit of result.hits) {
                if (!this.nsfw && hit.isNsfw) continue;
                const a = document.createElement('a');
                a.href = hit.url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.className = 'glass-card spicy-public-card';
                a.style.cssText = 'display:block;overflow:hidden;text-decoration:none;padding:8px;border-radius:12px';
                if (hit.avatar) {
                    const image = document.createElement('img');
                    image.src = hit.avatar;
                    image.loading = 'lazy';
                    image.referrerPolicy = 'no-referrer';
                    image.alt = '';
                    image.style.cssText = 'display:block;width:100%;height:190px;object-fit:cover;border-radius:8px';
                    a.appendChild(image);
                }
                const name = document.createElement('div');
                name.textContent = hit.name;
                name.style.cssText = 'font-weight:650;margin-top:8px;overflow-wrap:anywhere';
                a.appendChild(name);
                const author = document.createElement('small');
                author.textContent = [hit.creator ? '@'+hit.creator : '', hit.isNsfw ? 'NSFW' : '', hit.definitionVisible ? 'Public definition' : 'Definition unavailable'].filter(Boolean).join(' · ');
                a.appendChild(author);
                if (hit.tags.length) {
                    const tags = document.createElement('div');
                    tags.textContent = hit.tags.slice(0, 5).join(' · ');
                    tags.style.cssText = 'font-size:.75rem;opacity:.7;margin-top:5px';
                    a.appendChild(tags);
                }
                grid.appendChild(a);
            }
            this.setStatus(result.found ? `Found ${result.found} public characters. Open cards on SpicyChat.` : 'No results.');
            if (more) more.hidden = this.page * result.perPage >= result.found || result.hits.length === 0;
            this.page++;
        } catch (error) {
            if (gen !== this.generation || root !== this.container) return;
            console.warn('[SpicyChatProvider] Public search unavailable:', error);
            this.setStatus('Public search is unavailable: ' + (error?.message || String(error)) + '. You can still browse at spicychat.ai. No login credentials were accessed.');
        }
    }
}
export default new SpicyChatProvider();
