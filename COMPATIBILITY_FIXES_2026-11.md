# CharacterTavern / Botbooru compatibility fixes (November 2026)

This branch preserves fixes for `SillyTavern-CharacterLibrary` after the CharacterTavern site API changed.

## Included

- **CharacterTavern search:** use the SvelteKit `/search/cards/__data.json` page-data response instead of the removed `/api/search/cards` route; decode the indexed JSON structure.
- **CharacterTavern full cards:** fetch downloadable PNGs with `?action=download`, read embedded CCv3/CCv2 card metadata, preserve card fields during import, and avoid importing empty cards when details cannot be retrieved.
- **Proxy allowlist:** permit only the additional read-only CharacterTavern search endpoint in the bundled `extras/cl-helper` source.
- **Botbooru:** route authenticated requests through an available `cl-helper` even without Basic Auth. This is an observed local workaround, not a validated fix for every authentication configuration.

## Scope and limitations

- These changes are based on patches exercised on one Windows/SillyTavern installation. They have **not** passed cross-platform regression tests or CI.
- CharacterTavern `trending` currently maps to `best`; this is a known limitation from the first search compatibility patch. Trending/Top Rated sort names and parameters need separate server-side verification.
- The newer CharacterTavern tags endpoint and sorting changes were experimental and are **not part of this branch**.
- Botbooru NSFL visibility depends on server-side account flags `show_nsfw` and `show_nsfl`. The transport workaround does not guarantee that those flags are synchronized.
- The proxy bundled as `extras/cl-helper/index.js` is **not** automatically deployed to SillyTavern's installed `plugins/cl-helper/index.js`. Users must update the installed plugin separately.
- Do not commit credentials, tokens, cookies, user profiles, cards, or private chat files.

## Attribution and license

This is a modification of [Sillyanonymous/SillyTavern-CharacterLibrary](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary). Preserve the original AGPL-3.0 license and notices.

## Next steps

1. Review the diff and run JS syntax checks and targeted mocked-data tests.
2. Validate public CharacterTavern search, complete PNG card import, and Botbooru account login against the live services.
3. Validate NSFL account flag synchronization and sorting independently before extending this branch.
