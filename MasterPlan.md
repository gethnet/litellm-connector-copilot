# Master Rebuild Plan

**Restrictions**

- Perform the work in the `main-registry-rebuild` worktree as you have been.
- You may only reference the [ts-no-any skill](/workspaces/litellm-connector-copilot/main-registry-rebuild/.github/skills/ts-no-any/SKILL.md) and the [Agents file](main-registry-rebuild/AGENTS.md) outside of the code within the worktree.

**Pain Point**

The entire chat completions and responses paths in which actual work takes place is very delicate and will break if we mess with it too much.  As a result, We need to be extremely careful in editing it to ensure we do not regress functionality.

We will be working near them, they are not well documented.  And there is some conflicting internal documentation.  The goal here is to only update the code necessary.

## Phase 1 - Completed 16:45 06.07.2026

**Consider the following:**

- The registry itself most likely should be a singleton to ensure there are no duplicate instances with conflicting infromation.
- The 'module-level' token cache should move to be under each backend within the registry.  As we do not want to accumulate across providers.  In reality for better data resilliency it should be scoped to per-session.  Moving it to be under the provider will be beneifical.

**Context Point 1:**

When a provider is added, the key is stored inside of vscode under the new method.  However, we cannot trust to always get that key back for each request to the LiteLLM Backend.  As we've seen in the Copilot BYOK implementation, they use a registry which handles storing all of the backends and their required data points (baseUrl, apiKey, etc...).  We've gotten this mostly in-place now.  One noticable difference, is our is not a singleton while theirs is.  Given the issues I'v noticed during iterating on this, it makes sense on why it should.

**Tasks**

- Convert the registry Backend to be a single instance / singleton.  Ensure that we are accessing it correctly for that flow.
- Migrate 'Module Level Token Caching' to be scoped to the connected provider in the registry singleton.  As long as we have the id be the fully namespaced id for the model, we will always be able to identify the correct backend provider in the registry.
- Update tests to reflect that the registry backend must be a singleton / single instance.
- Update tests regarding the `Module Level Token Caching` refactor to `Provider Level Token Caching` under the registry.

**Validation:**

- New code should be lint and format error free.
- Project should compile
- Full test suite `npm run test:coverage` has been run
- Increamented the build number from `2.1.0-wt3` to `2.1.0-wt4`
- Built an installable visx using `npm run vscode:pack:dev`

**Cleanup/Final Tasks (When Done)**

- add a git commit to the work tree detailing the changeset.
- report work done, and recommend pressing next tasks.

## Phase 2 - Fixing Model Reporting

With phase 1 complete, we need to now resolve the issues with reporting models back to vscode.

We should only report models to the providers configured.  We should **not** be returning a default model list of combined models.  We should be returning a properly seperated by groups list of models per group.

In theory, if VSCode does the hint, it will also tell us or give us the required credentials for the query.  It is in this modelDiscovery phase that we should be creating the ProviderRegistry entry.

Investigate the work tree to see what we are currently doing so I can provide insight in how to move forward.

## Phase 3

However, we need to be VERY, and I mean **VERY** careful as we are going to be near code that handles the actual connection to LiteLLM and processing tool calls correctly and proeprly.  Any of the slightest of change here can and will result in a complete break most if not all of the functions relating to sending & recieving requests.

RIght now, I just want the registy promoted so we are doing just that.  Storing each configured backend data with api key and routing hints so chats across differing providers work as expected.

We will also need to offer/perform migration for legacy configs to a provider based config.

This is actually fairly easy, we need to update the `chatLanguageModels.json` file in the users profile.  What needs to be done specifically is:

scanning and identifying if any `"vender": "litellm-connector"` exists or not.  If not, we need to create an object entry for each backend in the legacy configuration and append it to that files list.  If they exist, identify by baseUrl for matching.  if there is an api key reference there already leave that reference in place the only field that is to be updated if it differs is the name.  And only that.

So we need to update or append:

```
  {
    "name": "<Legacy Backend Name>",
    "vendor": "litellm-connector",
    "baseUrl": "<legacy-baseUrl>",
    "apiKey": "${api-secret-ref}"
  }
```

The content of `chatLanguageModels.json` is a json array of that object.

All of those data points should already be captured from the legacy multi-backend adapter.

Once that file has been updated and saved, we need to remove the legacy backend data from the users config (Preserving the key as we transferred them to the new provider store).  And once that is done, trigger a vscode requested model refresh to re-populate the registry from the new config.

This should only occur on the detection of the legacy config.  It should notify the user that the configuration is being updated with a live status update and show completion when done.

If the user has a signle backend, we still need to ensure its migrated, however the 'name' should just show 'LiteLLM' in that instance.  The namespacing should keep things isolated as we namespace off of the URL.

When complete:

There should be none of the following remaining:
- legacy multi-backend code -> registry provider based / namespaced
- module level token caching -> registry provider based level token caching
- No global grouped model list ->  Each backend has a model list it reports in the approrpiate namespace / grouping.

The following must remain as they are
- `cache key`

Functional Goals

- Migration of legacy -> Modern + Clean up of legacy
- Not surfacing a default `LiteLLM` model group unless there is an explicity group named `LiteLLM`. We should only be returning based on the registry and each provider/backend should be returning its own data set that is not grouped.
- No change in tool calling,
- No change in headers, responses, streaming, or other functionality related to communicating with LiteLLM
- No change in token cache counting other than it is now backend scoped per backend.  (Prevents issues if the user runs multiple sessions across multiple backends)

** ALL WORK IN THIS WORK TREE**

You may only reference the following file for reading and following instructions in terms of writing code.

- `main-registry-rebuild/.github/skills/ts-no-any/SKILL.md`


