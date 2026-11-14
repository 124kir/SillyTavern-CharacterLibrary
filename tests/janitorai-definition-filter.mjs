// Run with: node tests/janitorai-definition-filter.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../modules/providers/janitorai/janitorai-definition-filter.js', import.meta.url), 'utf8');
const { filterPublicJanitoraiDefinitions } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const rows = ids => ids.map(character_id => ({ character_id }));
const isHidden = detail => !detail.personality;

test('only confirmed public definitions are shown; order preserved', async () => {
    const cache = new Map();
    const result = await filterPublicJanitoraiDefinitions(rows(['a', 'b', 'c']), {
        fetchDetail: async id => ({ personality: id === 'b' ? '' : 'Public' }),
        isHidden, cache,
    });
    assert.deepEqual(result.characters.map(x => x.character_id), ['a', 'c']);
    assert.equal(result.hidden, 1);
    assert.equal(result.unknown, 0);
});

test('listing metadata is not trusted; failed checks remain unknown', async () => {
    const result = await filterPublicJanitoraiDefinitions([
        { character_id: 'a', showdefinition: false, is_proxy_enabled: false },
        { character_id: 'b', showdefinition: false, is_proxy_enabled: true },
    ], {
        fetchDetail: async id => id === 'a' ? { personality: 'Public' } : null,
        isHidden, cache: new Map(),
    });
    assert.deepEqual(result.characters.map(x => x.character_id), ['a']);
    assert.equal(result.unknown, 1);
    assert.equal(result.hidden, 0);
});

test('cache prevents repeat detail fetches', async () => {
    let calls = 0;
    const cache = new Map();
    const options = { fetchDetail: async () => { calls++; return { personality: 'Public' }; }, isHidden, cache };
    await filterPublicJanitoraiDefinitions(rows(['a']), options);
    await filterPublicJanitoraiDefinitions(rows(['a']), options);
    assert.equal(calls, 1);
});

test('expired cache is refreshed', async () => {
    let calls = 0;
    const cache = new Map([['a', { public: false, expiresAt: 10 }]]);
    const result = await filterPublicJanitoraiDefinitions(rows(['a']), {
        fetchDetail: async () => { calls++; return { personality: 'Public' }; },
        isHidden, cache, now: () => 11,
    });
    assert.equal(calls, 1);
    assert.equal(result.characters.length, 1);
});

test('rate limit stops new checks and does not claim hidden status', async () => {
    const result = await filterPublicJanitoraiDefinitions(rows(['a', 'b', 'c']), {
        fetchDetail: async () => { const e = new Error('rate limit'); e.code = 'HAMPTER_RATE_LIMITED'; throw e; },
        isHidden, cache: new Map(), concurrency: 1,
    });
    assert.equal(result.blockedCode, 'HAMPTER_RATE_LIMITED');
    assert.equal(result.unknown, 3);
    assert.equal(result.hidden, 0);
});

test('concurrency capped at two by default', async () => {
    let active = 0, max = 0;
    await filterPublicJanitoraiDefinitions(rows(Array.from({length:8}, (_,i)=>String(i))), {
        fetchDetail: async () => {
            active++; max = Math.max(max, active);
            await new Promise(resolve => setTimeout(resolve, 1));
            active--;
            return { personality: 'Public' };
        },
        isHidden, cache: new Map(),
    });
    assert.equal(max, 2);
});
