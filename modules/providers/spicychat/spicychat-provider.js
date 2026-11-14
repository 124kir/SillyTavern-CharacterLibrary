// SpicyChat Online provider: native Character Library browse, preview and permitted imports.
// Public read-only endpoints, no account session, no hidden definition extraction.
import { ProviderBase } from '../provider-interface.js';
import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy } from '../provider-utils.js';
import { searchSpicyCharacters, fetchSpicyDetail, parseSpicyDetail, isSpicyImportable } from './spicychat-api.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
const msg = value => String(value || '').trim();
const safeId = value => /^[a-z0-9_-]{4,128}$/i.test(String(value || ''));

function buildCard(detail) {
    const id = String(detail.id);
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: detail.name || 'Unnamed',
            description: detail.description || '',
            personality: detail.personality || '',
            scenario: detail.scenario || '',
            first_mes: detail.firstMessage || '',
            mes_example: detail.examples || '',
            system_prompt: detail.systemPrompt || '',
            post_history_instructions: detail.postHistory || '',
            creator_notes: detail.tagline || '',
            creator: detail.creator || '',
            character_version: '',
            tags: detail.tags || [],
            alternate_greetings: detail.alternateGreetings || [],
            extensions: {
                spicychat: {
                    id, path: id, pageName: detail.name,
                    linkedAt: new Date().toISOString(), tagline: detail.tagline || '',
                },
            },
        },
    };
}

class SpicyChatBrowseView extends BrowseView {
    constructor(provider) {
        super(provider);
        this.page = 1;
        this.query = '';
        this.sort = 'popular';
        this.nsfw = false;
        this.hideHidden = CoreAPI.getSetting?.('spicyHideHiddenDefinitions') === true;
        this.tagInclude = new Set();
        this.tagExclude = new Set();
        this.tagFacets = [];
        this.tagSearch = '';
        this.hits = [];
        this.ids = new Set();
        this.hasMore = true;
        this.loading = false;
        this.token = 0;
        this.active = false;
        this.selected = null;
        this.detailToken = 0;
    }

    get previewModalId() { return 'spicyCharModal'; }
    getSearchInputId(mode) { return mode === 'character' ? 'spicySearch' : null; }
    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'popular', label: 'Trending (24h)' },
                { value: 'newest', label: 'Newest' },
            ],
            followingSortOptions: [], viewModes: [],
        };
    }
    _getImageGridIds() { return ['spicyGrid']; }
    _extractProviderIds(char, ids) {
        const id = char?.data?.extensions?.spicychat?.id;
        if (id) ids.add(String(id));
    }

    renderFilterBar() {
        return '<div class="browse-sort-container"><select id="spicySort" class="glass-select" aria-label="SpicyChat sorting"><option value="popular">Trending</option><option value="newest">Newest</option></select></div>' +
            '<details id="spicyTagsPanel" class="browse-tags-dropdown-container" style="position:relative">' +
            '<summary id="spicyTagsSummary" class="glass-btn" style="cursor:pointer;list-style:none"><i class="fa-solid fa-tags"></i> Tags</summary>' +
            '<div class="dropdown-menu browse-tags-dropdown" style="display:block;position:absolute;z-index:100;right:0;min-width:260px;max-height:360px;overflow:auto;background:var(--glass-bg, #222);padding:10px;border:1px solid var(--glass-border, #555)">' +
            '<input id="spicyTagSearch" type="search" placeholder="Find tags..." class="glass-input" autocomplete="off" aria-label="Find SpicyChat tags" style="width:100%">' +
            '<div id="spicyTagOptions" style="max-height:260px;overflow:auto"></div>' +
            '<button id="spicyTagClear" type="button" class="glass-btn">Clear tags</button>' +
            '<div class="settings-hint">Click tag: include → exclude → off. Include matches any selected tag.</div>' +
            '</div></details>' +
            '<label class="glass-btn nsfw-toggle" style="display:inline-flex;align-items:center;gap:6px"><input id="spicyNsfw" type="checkbox">Include NSFW</label>' +
            '<label class="glass-btn" style="display:inline-flex;align-items:center;gap:6px"><input id="spicyHideHidden" type="checkbox">Hide hidden definitions</label>' +
            '<button id="spicyRefresh" type="button" class="glass-btn icon-only" title="Refresh"><i class="fa-solid fa-rotate-right"></i></button>';
    }

    renderView() {
        return '<div class="browse-section" id="spicyBrowseSection">' +
          '<div class="browse-search-bar"><div class="browse-search-input-wrapper">' +
          '<i class="fa-solid fa-search"></i><input id="spicySearch" type="search" placeholder="Search SpicyChat characters..." autocomplete="off" maxlength="140">' +
          '<button id="spicySubmit" class="browse-search-submit" type="button" aria-label="Search"><i class="fa-solid fa-arrow-right"></i></button>' +
          '</div></div>' +
          '<div id="spicyStatus" class="browse-error-banner" role="status" aria-live="polite" style="padding:8px 16px;display:none"></div>' +
          '<div id="spicyGrid" class="browse-grid"></div>' +
          '<div class="browse-load-more" id="spicyLoadMore" style="display:none"><button id="spicyMoreBtn" class="glass-btn" type="button"><i class="fa-solid fa-plus"></i> Load More</button></div>' +
          '</div>';
    }

    renderModals() {
        return '<div id="spicyCharModal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-label="SpicyChat character preview">' +
          '<div class="modal-glass browse-char-modal">' +
          '<div class="modal-header">' +
          '<div class="browse-char-header-info"><img id="spicyCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">' +
          '<div><h2 id="spicyCharName">Character</h2><p class="browse-char-meta" id="spicyCharAuthor"></p></div></div>' +
          '<div class="modal-controls"><a id="spicyOpenOriginal" target="_blank" rel="noopener noreferrer" class="action-btn secondary"><i class="fa-solid fa-external-link"></i> Open</a>' +
          '<button id="spicyImport" type="button" class="action-btn primary" disabled>Checking...</button>' +
          '<button id="spicyClose" type="button" class="close-btn" aria-label="Close">&times;</button></div></div>' +
          '<div class="browse-char-body">' +
          '<div class="browse-char-tagline"><div id="spicyCharTagline" class="browse-tagline-text"></div></div>' +
          '<div class="browse-char-meta-grid"><div class="browse-char-stats"><div class="browse-stat"><i class="fa-solid fa-message"></i> <span id="spicyCharMessages">0</span> messages</div>' +
          '<div class="browse-stat" id="spicyCharVisibility">Loading definition status...</div></div><div id="spicyCharTags" class="browse-char-tags"></div></div>' +
          '<div id="spicyDetailStatus" role="status" aria-live="polite" style="padding:10px 0"></div>' +
          '<div class="browse-char-section"><h3 class="browse-section-title">Description</h3><div id="spicyCharDescription" class="scrolling-text"></div></div>' +
          '<div class="browse-char-section"><h3 class="browse-section-title">Scenario</h3><div id="spicyCharScenario" class="scrolling-text"></div></div>' +
          '<div class="browse-char-section"><h3 class="browse-section-title">First Message</h3><div id="spicyCharFirstMessage" class="scrolling-text first-message-preview"></div></div>' +
          '<div class="browse-char-section"><h3 class="browse-section-title">Example Dialogues</h3><div id="spicyCharExamples" class="scrolling-text"></div></div>' +
          '</div></div></div>';
    }

    init() {
        super.init();
        this.buildLocalLibraryLookup();
        const grid = document.getElementById('spicyGrid');
        if (grid) {
            grid.addEventListener('click', e => {
                const card = e.target.closest('.browse-card[data-spicy-id]');
                if (!card) return;
                const hit = this.hits.find(h => h.id === card.dataset.spicyId);
                if (hit) void this.openPreview(hit);
            });
            this.observeImages(grid);
        }
        document.getElementById('spicySubmit')?.addEventListener('click', () => this.newSearch());
        document.getElementById('spicySearch')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); this.newSearch(); }
        });
        document.getElementById('spicySort')?.addEventListener('change', () => this.newSearch());
        document.getElementById('spicyNsfw')?.addEventListener('change', () => this.newSearch());
        document.getElementById('spicyHideHidden')?.addEventListener('change', e => {
            this.hideHidden = e.target.checked;
            CoreAPI.setSetting?.('spicyHideHiddenDefinitions', this.hideHidden);
            this.newSearch();
        });
        document.getElementById('spicyTagSearch')?.addEventListener('input', e => {
            this.tagSearch = e.target.value.trim().toLocaleLowerCase();
            this.renderTagOptions();
        });
        document.getElementById('spicyTagClear')?.addEventListener('click', () => {
            this.tagInclude.clear();
            this.tagExclude.clear();
            this.renderTagOptions();
            this.newSearch();
        });
        document.getElementById('spicyRefresh')?.addEventListener('click', () => this.newSearch());
        document.getElementById('spicyMoreBtn')?.addEventListener('click', () => { void this.loadMore(); });
        const modal = document.getElementById('spicyCharModal');
        if (modal && !modal.dataset.spicyWired) {
            modal.dataset.spicyWired = '1';
            modal.querySelector('#spicyClose')?.addEventListener('click', () => this.closePreview());
            modal.addEventListener('click', e => { if (e.target === modal) this.closePreview(); });
            modal.querySelector('#spicyImport')?.addEventListener('click', () => { void this.importSelected(); });
        }
    }

    activate(container, options = {}) {
        this.active = true;
        if (options.domRecreated) {
            this.query = '';
            this.sort = 'popular';
            this.nsfw = false;
            this.tagFacets = [];
            this.tagInclude.clear();
            this.tagExclude.clear();
            this.tagSearch = '';
            this.hits = [];
            this.ids.clear();
            this.page = 1;
            this.hasMore = true;
            this.loading = false;
        }
        super.activate(container, options);
        const input = document.getElementById('spicySearch');
        if (input) input.value = this.query;
        const sort = document.getElementById('spicySort');
        if (sort) sort.value = this.sort;
        const nsfw = document.getElementById('spicyNsfw');
        if (nsfw) nsfw.checked = this.nsfw;
        const hide = document.getElementById('spicyHideHidden');
        if (hide) hide.checked = this.hideHidden;
        this.renderTagOptions();
        if (!this.hits.length) void this.loadPage(true);
        else this.renderGrid();
    }

    deactivate() {
        this.active = false;
        this.token++;
        this.loading = false;
        this.closePreview();
        super.deactivate();
        this.disconnectImageObserver();
    }

    closePreview() {
        this.detailToken++;
        this.selected = null;
        document.getElementById('spicyCharModal')?.classList.add('hidden');
    }

    canLoadMore() { return this.active && this.hasMore && !this.loading; }
    loadMore() { return this.loadPage(false); }

    newSearch() {
        this.query = document.getElementById('spicySearch')?.value?.trim() || '';
        this.sort = document.getElementById('spicySort')?.value || 'popular';
        this.nsfw = document.getElementById('spicyNsfw')?.checked === true;
        this.hideHidden = document.getElementById('spicyHideHidden')?.checked === true;
        void this.loadPage(true);
    }

    renderTagOptions() {
        const list = document.getElementById('spicyTagOptions');
        const summary = document.getElementById('spicyTagsSummary');
        if (summary) {
            const count = this.tagInclude.size + this.tagExclude.size;
            summary.textContent = count ? 'Tags (' + count + ')' : 'Tags';
        }
        if (!list) return;
        list.replaceChildren();
        // Preserve selected tags even when the current facet page has no matching entries.
        const known = new Map(this.tagFacets.map(t => [t.name, t.count]));
        for (const tag of [...this.tagInclude, ...this.tagExclude]) if (!known.has(tag)) known.set(tag, null);
        const matches = [...known.entries()].filter(([tag]) => tag.toLocaleLowerCase().includes(this.tagSearch))
            .sort(([a], [b]) => {
                const activeA = this.tagInclude.has(a) || this.tagExclude.has(a);
                const activeB = this.tagInclude.has(b) || this.tagExclude.has(b);
                return Number(activeB) - Number(activeA) || a.localeCompare(b);
            });
        if (!matches.length) {
            const empty = document.createElement('div');
            empty.textContent = 'No tags in current results';
            empty.style.padding = '10px';
            list.appendChild(empty);
        }
        for (const [tag, count] of matches) {
            const state = this.tagInclude.has(tag) ? 'include' : this.tagExclude.has(tag) ? 'exclude' : 'off';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'glass-btn';
            button.style.cssText = 'width:100%;display:flex;justify-content:space-between;gap:8px;text-align:left;margin:3px 0';
            button.setAttribute('aria-pressed', state !== 'off' ? 'true' : 'false');
            const mark = state === 'include' ? '+ ' : state === 'exclude' ? '− ' : '';
            button.textContent = mark + tag + (count == null ? '' : ' (' + count + ')');
            button.title = state === 'include' ? 'Included. Click to exclude' : state === 'exclude' ? 'Excluded. Click to clear' : 'Click to include';
            button.addEventListener('click', () => {
                if (state === 'off') { this.tagInclude.add(tag); this.tagExclude.delete(tag); }
                else if (state === 'include') { this.tagInclude.delete(tag); this.tagExclude.add(tag); }
                else { this.tagInclude.delete(tag); this.tagExclude.delete(tag); }
                this.renderTagOptions();
                this.newSearch();
            });
            list.appendChild(button);
        }
    }

    status(text) {
        const el = document.getElementById('spicyStatus');
        if (!el) return;
        el.textContent = text || '';
        el.style.display = text ? 'block' : 'none';
    }

    async loadPage(reset = false) {
        if (!this.active || (!reset && (this.loading || !this.hasMore))) return;
        const token = ++this.token;
        const requestedPage = reset ? 1 : this.page;
        if (reset) {
            this.page = 1;
            this.hits = [];
            this.ids.clear();
            this.hasMore = true;
            document.getElementById('spicyGrid')?.replaceChildren();
        }
        this.loading = true;
        const more = document.getElementById('spicyMoreBtn');
        if (more) more.disabled = true;
        this.status('Loading SpicyChat characters...');
        try {
            const result = await searchSpicyCharacters({
                query: this.query, page: requestedPage, perPage: 24,
                nsfw: this.nsfw, sort: this.sort,
                hideHidden: this.hideHidden,
                includeTags: [...this.tagInclude], excludeTags: [...this.tagExclude],
            });
            if (token !== this.token || !this.active) return;
            this.tagFacets = result.tagFacets || [];
            this.renderTagOptions();
            for (const hit of result.hits) {
                if (!this.nsfw && hit.isNsfw) continue;
                if (this.ids.has(hit.id)) continue;
                this.ids.add(hit.id);
                this.hits.push(hit);
            }
            this.page = requestedPage + 1;
            this.hasMore = requestedPage * result.perPage < result.found && requestedPage < 100 && result.hits.length > 0;
            this.renderGrid();
            this.status(result.found ? 'Found ' + result.found.toLocaleString() + ' SpicyChat characters' +
                (this.hideHidden ? ' with public definitions' : '') : 'No characters found');
        } catch (error) {
            if (token !== this.token || !this.active) return;
            this.status('SpicyChat search error: ' + (error?.message || error));
            console.warn('[SpicyChat] Search failed', error);
        } finally {
            if (token === this.token) {
                this.loading = false;
                if (more) more.disabled = false;
                this.updateLoadMoreVisibility('spicyLoadMore', this.hasMore, this.hits.length > 0);
            }
        }
    }

    renderGrid() {
        const grid = document.getElementById('spicyGrid');
        if (!grid) return;
        const existing = new Set([...grid.querySelectorAll('[data-spicy-id]')].map(node => node.dataset.spicyId));
        const fragment = document.createDocumentFragment();
        for (const hit of this.hits) {
            if (existing.has(hit.id)) continue;
            const card = document.createElement('div');
            card.className = 'browse-card';
            card.dataset.spicyId = hit.id;
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-label', 'Preview ' + hit.name);
            card.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void this.openPreview(hit); }
            });
            const imageBox = document.createElement('div');
            imageBox.className = 'browse-card-image';
            const img = document.createElement('img');
            img.src = '/img/ai4.png';
            img.alt = hit.name;
            img.loading = 'lazy';
            if (hit.avatar) img.dataset.src = hit.avatar;
            imageBox.appendChild(img);
            if (hit.isNsfw) {
                const badge = document.createElement('span');
                badge.className = 'browse-nsfw-badge';
                badge.textContent = 'NSFW';
                imageBox.appendChild(badge);
            }
            card.appendChild(imageBox);
            const body = document.createElement('div');
            body.className = 'browse-card-body';
            const name = document.createElement('div');
            name.className = 'browse-card-name';
            name.textContent = hit.name;
            body.appendChild(name);
            const creator = document.createElement('div');
            creator.className = 'browse-card-creator';
            creator.textContent = hit.creator ? '@' + hit.creator : '';
            body.appendChild(creator);
            const tags = document.createElement('div');
            tags.className = 'browse-card-tags';
            for (const tag of hit.tags.slice(0, 3)) {
                const label = document.createElement('span');
                label.className = 'browse-card-tag';
                label.textContent = tag;
                tags.appendChild(label);
            }
            body.appendChild(tags);
            card.appendChild(body);
            const footer = document.createElement('div');
            footer.className = 'browse-card-footer';
            const messages = document.createElement('span');
            messages.className = 'browse-card-stat';
            messages.textContent = Number(hit.messages || 0).toLocaleString() + ' messages';
            footer.appendChild(messages);
            if (this._lookup.byProviderId.has(hit.id)) {
                card.classList.add('in-library');
                const owned = document.createElement('span');
                owned.className = 'browse-feature-badge in-library';
                owned.textContent = 'In library';
                footer.appendChild(owned);
            }
            card.appendChild(footer);
            fragment.appendChild(card);
        }
        grid.appendChild(fragment);
        this.observeImages(grid);
        this.updateLoadMoreVisibility('spicyLoadMore', this.hasMore, this.hits.length > 0);
    }

    async openPreview(hit) {
        this.selected = { hit, detail: null };
        const token = ++this.detailToken;
        const modal = document.getElementById('spicyCharModal');
        if (!modal) return;
        const set = (id, text) => {
            const node = document.getElementById(id);
            if (node) node.textContent = text || '';
        };
        const avatar = document.getElementById('spicyCharAvatar');
        if (avatar) avatar.src = hit.avatar || '/img/ai4.png';
        set('spicyCharName', hit.name);
        set('spicyCharAuthor', hit.creator ? 'by @' + hit.creator : '');
        set('spicyCharTagline', hit.title || '');
        set('spicyCharMessages', Number(hit.messages || 0).toLocaleString());
        set('spicyCharVisibility', 'Loading public definition...');
        set('spicyCharDescription', '');
        set('spicyCharScenario', '');
        set('spicyCharFirstMessage', '');
        set('spicyCharExamples', '');
        set('spicyDetailStatus', 'Loading character details...');
        const tags = document.getElementById('spicyCharTags');
        if (tags) tags.textContent = hit.tags.join(' · ');
        const open = document.getElementById('spicyOpenOriginal');
        if (open) open.href = hit.url;
        const importBtn = document.getElementById('spicyImport');
        if (importBtn) { importBtn.disabled = true; importBtn.textContent = 'Checking...'; }
        modal.classList.remove('hidden');
        try {
            const raw = await fetchSpicyDetail(hit.id);
            if (token !== this.detailToken) return;
            const detail = parseSpicyDetail(raw, hit);
            this.selected.detail = detail;
            set('spicyCharVisibility', detail.definitionVisible ? 'Public definition' : 'Definition hidden by creator');
            set('spicyCharTagline', detail.tagline || '');
            set('spicyCharDescription', detail.definitionVisible
                ? (detail.description || detail.personality || 'No description provided')
                : 'The creator did not make the character definition public.');
            set('spicyCharScenario', detail.scenario);
            set('spicyCharFirstMessage', detail.firstMessage);
            set('spicyCharExamples', detail.examples);
            set('spicyDetailStatus', isSpicyImportable(detail)
                ? 'Full public definition available. You can import this character.'
                : 'Import disabled: the complete character definition or greeting is unavailable.');
            if (tags) tags.textContent = detail.tags.join(' · ');
            if (importBtn) {
                importBtn.disabled = !isSpicyImportable(detail);
                importBtn.textContent = isSpicyImportable(detail) ? 'Import to SillyTavern' : 'Import unavailable';
            }
        } catch (error) {
            if (token !== this.detailToken) return;
            set('spicyCharVisibility', 'Details unavailable');
            set('spicyCharDescription', 'Character details could not be retrieved. The public listing remains available.');
            set('spicyDetailStatus', 'Unable to load details: ' + (error?.message || error));
            if (importBtn) { importBtn.disabled = true; importBtn.textContent = 'Import unavailable'; }
        }
    }

    async importSelected() {
        const selected = this.selected;
        if (!selected?.detail || !isSpicyImportable(selected.detail)) return;
        const btn = document.getElementById('spicyImport');
        if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
        try {
            const matching = await CoreAPI.checkCharacterForDuplicatesAsync({
                name: selected.detail.name, creator: selected.detail.creator,
                fullPath: selected.detail.id, description: selected.detail.description,
                first_mes: selected.detail.firstMessage,
            });
            if (matching?.length) {
                const choice = await CoreAPI.showPreImportDuplicateWarning({
                    name: selected.detail.name, creator: selected.detail.creator,
                    fullPath: selected.detail.id, avatarUrl: selected.detail.avatar,
                }, matching);
                // Do not delete/replace existing local cards in this initial integration.
                if (choice?.choice !== 'import' && choice?.choice !== 'keep-both') {
                    CoreAPI.showToast?.('Import cancelled to avoid changing an existing character', 'info');
                    return;
                }
            }
            const provider = CoreAPI.getProvider('spicychat');
            const result = await provider.importCharacter(selected.detail.id, selected.hit);
            if (!result?.success) throw new Error(result?.error || 'Import failed');
            this._lookup.byProviderId.add(selected.detail.id);
            CoreAPI.showToast?.('Imported ' + result.characterName, 'success');
            this.closePreview();
            const grid = document.getElementById('spicyGrid');
            if (grid) {
                const card = [...grid.querySelectorAll('.browse-card[data-spicy-id]')].find(node => node.dataset.spicyId === selected.detail.id);
                card?.classList.add('in-library');
            }
        } catch (error) {
            CoreAPI.showToast?.('SpicyChat import failed: ' + (error?.message || error), 'error');
        } finally {
            if (btn) { btn.disabled = !this.selected?.detail || !isSpicyImportable(this.selected.detail); btn.textContent = 'Import to SillyTavern'; }
        }
    }
}

class SpicyChatProvider extends ProviderBase {
    constructor() {
        super();
        this.view = new SpicyChatBrowseView(this);
        this.api = null;
    }
    get id() { return 'spicychat'; }
    get name() { return 'SpicyChat'; }
    get icon() { return 'fa-solid fa-pepper-hot'; }
    get beta() { return true; }
    get disabledByDefault() { return true; }
    get enableWarning() {
        return 'Experimental SpicyChat provider. Searches public listings and only imports characters whose complete definitions are public. No account login.';
    }
    get browseView() { return this.view; }
    get hasView() { return true; }
    async init(api) { await super.init(api); this.api = api; }
    renderFilterBar() { return this.view.renderFilterBar(); }
    renderView() { return this.view.renderView(); }
    renderModals() { return this.view.renderModals(); }
    activate(container, options = {}) { this.view.activate(container, options); }
    deactivate() { this.view.deactivate(); }
    getLinkInfo(char) {
        const id = char?.data?.extensions?.spicychat?.id;
        return id ? { providerId: 'spicychat', id, fullPath: id } : null;
    }
    getListingName(hit) { return hit?.name || null; }
    canHandleUrl(url) {
        try {
            const u = new URL(url);
            return u.hostname === 'spicychat.ai' && /^\/(chatbot|chat)\/[\w-]+\/?$/.test(u.pathname);
        } catch { return false; }
    }
    parseUrl(url) { return this.canHandleUrl(url) ? new URL(url).pathname.split('/')[2] : null; }
    get supportsInAppPreview() { return true; }
    async buildPreviewObject(_char, link) {
        if (!safeId(link?.id)) return null;
        const id = String(link.id);
        const raw = await fetchSpicyDetail(id);
        return { ...parseSpicyDetail(raw, { id }), id };
    }
    openPreview(hit) {
        const original = this.view.hits.find(item => item.id === hit?.id);
        if (original) return this.view.openPreview(original);
        return this.view.openPreview(hit);
    }
    async fetchMetadata(id) {
        try { return await fetchSpicyDetail(id); }
        catch { return null; }
    }
    async fetchRemoteCard(link) {
        const raw = await fetchSpicyDetail(link?.id || link?.fullPath, { refresh: true });
        const detail = parseSpicyDetail(raw, { id: link?.id });
        return isSpicyImportable(detail) ? buildCard(detail) : null;
    }
    async importCharacter(id, hit = {}, options = {}) {
        try {
            const raw = await fetchSpicyDetail(id, { refresh: true });
            const detail = parseSpicyDetail(raw, { id: String(id), ...hit });
            if (!isSpicyImportable(detail)) {
                throw new Error('The creator has not published a complete character definition and greeting');
            }
            const card = buildCard(detail);
            assignGalleryId(card, options, this.api);
            let imageBuffer = null;
            if (detail.avatar) {
                try {
                    const image = await fetchWithProxy(detail.avatar);
                    const mime = image.headers.get('content-type') || '';
                    if (!mime.toLowerCase().startsWith('image/')) throw new Error('Avatar is not an image');
                    const contentLength = Number(image.headers.get('content-length'));
                    if (contentLength > 8 * 1024 * 1024) throw new Error('Avatar too large');
                    imageBuffer = await image.arrayBuffer();
                    if (imageBuffer.byteLength > 8 * 1024 * 1024) throw new Error('Avatar too large');
                } catch (error) {
                    console.warn('[SpicyChat] Avatar unavailable, using placeholder:', error?.message);
                }
            }
            return await importFromPng({
                characterCard: card, imageBuffer,
                fileName: 'spicy_' + String(id).replace(/[^\w-]/g, '') + '.png',
                characterName: detail.name,
                providerCharId: detail.id,
                fullPath: detail.id,
                avatarUrl: detail.avatar, api: this.api,
            });
        } catch (error) {
            console.error('[SpicyChat] Import error:', error);
            return { success: false, error: error?.message || String(error) };
        }
    }
}
export default new SpicyChatProvider();
