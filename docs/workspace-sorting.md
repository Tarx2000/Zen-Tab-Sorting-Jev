# Sorting across Spaces

Right-click a Space or open its native actions menu and choose **Alle Spaces
automatisch sortieren**. The action sorts the Spaces of the current browser
window using the configured Jev provider. It requires the existing data-sending
consent and Jev credentials, independently of the engine selected for ordinary
tab grouping. It never calls the fallback LLM and never creates Spaces or groups.

Space names have the highest authority. Contents in a meaningfully named Space
cannot redefine that name: Flutter tabs misfiled in SocialMedia do not make it a
development Space. Only generic names such as Space2, Workspace 3 or an emoji-only
name get weak examples from current contents. An evaluated unit is excluded from
its own examples. No page snippets are fetched by this action.

Each ungrouped tab is one unit. Each top-level tab group, native Zen folder or
split view is one indivisible unit, including its nested children. Empty folders
and pinned tabs participate. Essentials, glance tabs and internal placeholders
are excluded. A skip-domain match anywhere in a tree excludes the complete tree.
Equal labels never merge objects. Stable Space IDs and live object references
identify destinations and units.

Jev scores every existing Space. The highest score wins, but a transfer requires:

```text
best destination score − current Space score > 0.10
```

Exactly ten percentage points is not enough. There is no separate minimum score
or margin against the runner-up. Exact ties prefer the current Space, then Space
order. Missing or invalid scores cannot authorize a move.

Failed requests or invalid answers get **one retry**, for two attempts total.
Only unanswered units are retried. Failed batches do not stop later batches.
Native move failures also get one retry, checking first whether the move already
succeeded. Persistent failures leave the unit in place and appear in the final
error report. There is no Undo action. Units changed by the user while Jev was
working are skipped rather than applying stale decisions.

Transfers preserve the same tab/group objects, member order, parent hierarchy,
container identities, colors and collapsed states. Incoming units append in their
respective pinned or normal section. Individual tabs remain ungrouped. The active
tab stays selected and its destination Space opens once after completion, unless
the user changed selection or Space during execution.

Normal group Space/parent/collapse metadata is also saved in Firefox SessionStore
as a value belonging to this window. This repairs metadata Zen otherwise loses
on restart. Native folders retain their own native persistence.

Both this action and ordinary Autosort share a per-window run lock. Ordinary
Autosort now plans its changes before mutating the browser; canceling Plan Mode
does not apply its earlier rule/cleanup steps. The native changes are presented
with Zen Motion flights and layout animations. Hidden/background moves receive a
compact route summary. Flights overlap with a three-second presentation budget;
reduced-motion preferences disable them. Temporary overlays contain inert HTML,
never cloned browser tabs.

## Native drag compatibility

Normal tab groups can use a layout whose group box has zero width/height even
though its label is visible. For that specific case the adapter passes the
visible header through Zen's existing `dragImageSource` option. Zen still owns
the drag data, image, cursor offsets, move bookkeeping and drop handling.

Header edges use native reorder markers; the middle remains a group drop target.
Both current and older Firefox tab drag MIME types are recognized. Drag-image and
Library copies are excluded from sorting and state observers. These changes do
not require installing Advanced Tab Groups. Edge targeting is adapted from it;
see the third-party notice.

## Verification

```sh
npm run check
npm run e2e:zen -- --tabs 300
npm run e2e:workspaces
npm run e2e:workspaces -- --tabs 300 --restart
ZEN_WORKSPACE_ARTIFACTS=/tmp/zen-workspace-check npm run e2e:workspaces -- --headed --drag
```

The Workspace harness uses a disposable Sine profile, local fixture pages and an
intercepted fake Jev response. It does not sort the user's live profile or call a
real provider. The headed drag case uses actual WebDriver pointer actions and
checks native drag-image dimensions and edge markers. Frame traces and optional
PNG captures verify intermediate motion in addition to final membership.
The exact edge coordinate is additionally probed using the active native drag
payload to avoid OS pointer coalescing. The restart gate checks saved group IDs,
Spaces, hierarchy and collapsed states after quitting and reopening the lab.

## Library Autosort

Each Library Space card has one persistent wand icon in its header, next to the
theme button. Copied sidebar icons are removed, so even completely grouped or
empty Spaces retain one visible action. It
sorts the real tabs in that card’s Space into groups using the normal Autosort
settings. It does not run the cross-Space sorter. The previous Space and selected
tab are restored afterward unless the user navigates during the sort. The
Library refreshes its copies after native mutations complete.

ChatGPT refreshes save replacement credentials before another provider call and
share a lock across chrome windows. A terminal `invalid_grant` requires a new
**Sign in with ChatGPT** in the mod settings; revoked credentials cannot be
recovered locally. The issued client ID is retained for reconnecting. Temporary
network/server failures retain the credentials. This follows OpenAI’s
[session refresh](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
and [error recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) guidance.

Run the native Library and simulated OAuth regression with:

```sh
npm run e2e:library -- --headed
```

## Provider settings

Normal Autosort always uses Jev for existing groups, then the selected LLM for
new groups. Settings are split into three cards: Jev, LLM and sorting behavior.
Choose the Jev service/key/model independently from ChatGPT, PrimaLabs,
OpenAI-compatible, Gemini, Ollama or Custom. Each stage has its own connection
test. API keys are masked and only the selected LLM’s fields are visible.

Choose loose tabs only or all tabs, and automatic application or preview. The
Jev probability and runner-up margin controls live in its collapsed confidence
section; they do not replace the fixed 10-point improvement rule for Spaces.
Optional domain rules and diagnostics are also collapsed by default.

On update, a former standalone provider becomes the LLM in stage 2. Credentials
and custom models remain stored. The former duplicate hybrid/rules-first modes
are unified; old fresh-category and rename prompts migrate to all-tabs and plan
preview respectively. Turning off the fallback is no longer a settings option.

The settings form can be exercised in a disposable native Sine profile with
`npm run e2e:settings -- --headed`. This checks all six LLM choices, actual Sine
field rendering, model persistence and key masking without provider requests.
