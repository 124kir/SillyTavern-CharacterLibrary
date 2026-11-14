# SpicyChat public discovery — experimental

This branch extends `fix/character-tavern-botbooru-2026` and adds an **opt-in, discovery-only** provider to the Character Library **Online** selector.

## What is included

- SpicyChat search based on the publicly described Typesense `public_characters_alias` index
- Character name, author, preview avatar, tags, NSFW status, definition-visibility indicator, link to the original SpicyChat profile
- Query, Trending / Newest, pagination, and an opt-in NSFW checkbox (SFW by default)
- An explicit failure message with a link to SpicyChat when anonymous search fails
- No login integration, no password or cookies, no local storage of API keys, no card import, no hidden-definition extraction

## Important limitation

The search transport is **not yet live-tested**. An unofficial third-party Python client retrieves `typesenseConfig.apiKeyPublicCharacter` from the SpicyChat application-settings endpoint and calls Typesense `/multi_search`. That client's settings request uses authenticated mode, so the endpoint might reject anonymous requests. The experimental provider deliberately does NOT try to borrow credentials, scrape sessions, or bypass access controls. If anonymous access fails, use the site directly.

This is a test prototype, **not a verified working search integration** and not a published release. Keep the provider disabled in settings until you want to test it.

### Verify manually

1. In Character Library settings enable the SpicyChat provider (Beta). Start SillyTavern and open Online → SpicyChat.
2. Enter an ordinary, non-sensitive test query and click Search.
3. If available, check results / pagination and compare with the site's public catalogue.
4. Confirm NSFW checkbox defaults to off and that results with `is_nsfw: true` are not shown in SFW mode.
5. Open a card: it must open only `https://spicychat.ai/chatbot/<id>`, not import anything into SillyTavern.
6. Look for errors in F12 → Console and Network. Do not send session tokens or request headers when reporting errors.
7. Disable the provider again if the site's search API requires authorization.

### Prior art

- https://github.com/SSL-ACTX/spicychat-api — unofficial Python client, search via Typesense; this implementation is independent, with no copied login code
- https://github.com/drachescript/spicychat-qol-extension — public chatbot profile URL shape

This is not affiliated with SpicyChat. Respect authors' visibility settings and the site's terms of service. Do not import or redistribute private definitions.

**No secrets or access tokens are committed.**
