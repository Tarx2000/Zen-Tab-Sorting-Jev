# Zen Tab Sorting

A tab organizer for [Zen Browser](https://zen-browser.app), installed through the [Sine](https://github.com/CosmoCreeper/Sine) mod loader. You define domain rules, click the wand button in the workspace separator, and your open tabs drop into groups. An AI pass is available for whatever the rules don't cover, and it stays off until you turn it on.

![Zen Tab Sorting sorting tabs into groups in the Zen sidebar](assets/in-action.gif)

## Installing

Installing from the Sine mod store takes nothing beyond the install itself. Store mods run as they are.

To install straight from this repository instead, add it in Sine:

```text
LoopRook/Zen-Tab-Sorting
```

That route needs one setting turned on first, because Sine only runs a mod's JavaScript if the mod came from its official store. Enable "Enable installing JS from unofficial sources" in Sine's settings, then restart Zen before installing. Without it the stylesheet still loads but none of the behavior does, so you get no wand button and no settings editors.

Don't run this alongside Zen Tab Wand or OpenTabSort Zen. All three share the same toolbar button, command, and preference keys, so two of them installed at once will fight over the same DOM.

After installing, a wand button appears in the workspace separator. Left-click sorts the current workspace. Right-click any tab to add its hostname to a rule or to the skip list.

Right-click a Space and choose **Alle Spaces automatisch sortieren** to route
whole groups and individual tabs into existing Spaces with Jev. Names determine
each Space's topic. A move requires more than ten percentage points of improvement
over the current Space. Groups, nested folders, pinned tabs and split views stay
intact; skip-domain groups stay put. Failed items get one retry and an error report;
other items continue. This action uses no fallback LLM and offers no Undo.
See [Workspace sorting](docs/workspace-sorting.md) for its exact behavior.

Sorting now animates tab movements with Zen Motion. Normal groups also receive
native drag previews and header-edge insertion markers without requiring Advanced
Tab Groups to be installed.

## How sorting works

1. Domain rules run first. You define groups in settings, say a `Dev` group matching `github.com` and `stackoverflow.com`, and every open tab whose hostname matches lands in that group.
2. Skip domains are pulled out. Anything matching the skip list gets ejected from its group and parked at the top of the workspace, on every click.
3. The AI pass handles the rest, if you've enabled one. It can file leftover tabs into existing groups or invent new ones.

Normal Autosort always uses two stages: Jev classifies tabs into existing groups, then the selected LLM creates new groups for the remaining tabs. Choose whether to sort only loose tabs or reconsider all tabs, and whether to apply new groups automatically or preview the plan first.

## Jev and the LLM

Configure **Jev** independently: select TypeSafe or OpenRouter, enter that service’s API key, and choose the Jev model. Confidence thresholds are under its advanced section.

Then choose the **LLM for new groups**:

| Provider | Connection settings |
| --- | --- |
| ChatGPT | Sign in with ChatGPT; load or enter a model |
| PrimaLabs | API key, endpoint and model |
| OpenAI-compatible | API key, base URL and model |
| Gemini | API key and model |
| Ollama | Local host and model; optional preloading |
| Custom | OpenAI or Ollama request format, endpoint, key and model |

Only the chosen LLM’s fields are shown. Both stages have their own connection test. API keys are masked and can be revealed individually. Credentials are retained when switching providers.

Consent to send tab titles, URLs and optional snippets is required before sorting. Jev is a remote service, so choosing a local Ollama LLM still requires consent for stage 1. Space-menu sorting uses Jev only and moves existing groups intact.

## Settings

The settings follow the sorting order: **1. Existing groups — Jev**, **2. New groups — LLM**, and **3. Sorting behavior**. Existing standalone-provider selections are migrated into stage 2; keys, models and saved ChatGPT sessions remain in place.

Excluded sites and appearance options remain directly accessible. Domain rules, backups and diagnostics have collapsible sections. Domain rules are optional and run before Jev when enabled. Group Rules holds names, colors and domain lists; Skip Domains lists excluded hosts; Backup and Restore exports both lists without provider credentials.

## What this fork changes

The visual side is reskinned after [Advanced Tab Groups](https://github.com/Vertex-Mods/Advanced-Tab-Groups). Groups get a colored accent bar down the side of their tabs and a tidier label row, all keyed to Zen's own theme variables so it follows your theme rather than fighting it.

![An expanded group showing its accent bar above a collapsed group showing its marker](assets/Overview.png)

Collapsed groups get a different treatment. Firefox paints a collapsed group's label as a filled colored chip, which reads as a heavy box in Zen's vertical sidebar, so this mod strips it back to a plain label with a small colored marker beside the name. You can set the marker to a circle or a rounded square, or turn it off entirely. Each shape keeps its own size, and you choose whether the marker shrinks, stays the same, or disappears when you open the group.

| Circle | Rounded square |
| --- | --- |
| ![Groups marked with circles](assets/Circle.png) | ![The same groups marked with rounded squares](assets/Square.png) |

Two fixes carried over from Zen Tab Wand patch things Zen still gets wrong. Collapsing a group actually hides its tabs, which sounds obvious until you try it: Zen's vertical sidebar never shipped the CSS for it, so the chevron toggled a state that changed nothing ([#11134](https://github.com/zen-browser/desktop/issues/11134), [#11739](https://github.com/zen-browser/desktop/issues/11739)). Collapsed groups also stay collapsed across restarts, because Zen's session store drops that state and the mod saves the collapsed group names separately and reapplies them when groups are restored.

Right-clicking a group header gives you a Dissolve group option, which removes the group and leaves its tabs in place at the top of the workspace.

## Credits

This is based on [Zen Tab Wand](https://github.com/flantig/Zen-Tab-Wand) by flantig, by way of [OpenTabSort Zen](https://github.com/nggurbanov/OpenTabSort-Zen) by nggurbanov, which added the remote provider support and the test harness. Both are MIT licensed and their copyright stands.

Preferences are still stored under the `extensions.zen-auto-organize.*` prefix from the original, so rules and settings carry over if you're coming from either of those mods.

## Development

```sh
npm install
npm run check
```

`npm run check` runs the manifest, preferences and security validators, then the test suite. There's also an end-to-end runner that drives a real Sine-loaded Zen in a throwaway profile:

```sh
npm run e2e:zen -- --tabs 300
```

It builds its own profile, copies the Sine engine from an existing one, and never touches your main profile. By default it talks to a local fake provider rather than a real API.

## License

MIT. The original Zen Tab Wand copyright remains in `LICENSE`.
