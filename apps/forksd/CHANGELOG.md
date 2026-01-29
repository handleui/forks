# forksd

## [0.3.0](https://github.com/handleui/forks/compare/v0.2.0...v0.3.0) (2026-01-29)


### Features

* add baseInstructions support and skill loading utilities ([#8](https://github.com/handleui/forks/issues/8)) ([4799f2a](https://github.com/handleui/forks/commit/4799f2a92deada3eeb20fd011716d2da9212dc42))
* add codex chatgpt authentication support ([#4](https://github.com/handleui/forks/issues/4)) ([a58d2ef](https://github.com/handleui/forks/commit/a58d2efaec6df34a6ae955b124e28efbfcb86ae5))
* add collaboration mode support for plan vs execute workflows ([#24](https://github.com/handleui/forks/issues/24)) ([31a6d3f](https://github.com/handleui/forks/commit/31a6d3fd5d018825d4ad9cdee946e3e6afbfa447))
* add graphite stack management tools and events ([#20](https://github.com/handleui/forks/issues/20)) ([60916e6](https://github.com/handleui/forks/commit/60916e6404d7cf7411ddf1a90c76a0a18a9b90a2))
* add task-plan linking and enhanced task management ([#18](https://github.com/handleui/forks/issues/18)) ([39ff01a](https://github.com/handleui/forks/commit/39ff01a756a1e2d5bef88846fcc4cf441da678d1))
* **codex:** add process exit handling, restart, and source detection ([#25](https://github.com/handleui/forks/issues/25)) ([f8d5334](https://github.com/handleui/forks/commit/f8d53340453d638a972dbdd482718e20171a54ed))
* dsn passed to daemon ([a24e704](https://github.com/handleui/forks/commit/a24e704098963c97704658753d7440fd40abb021))
* enhance sentry error tracking and release automation ([#13](https://github.com/handleui/forks/issues/13)) ([6ed8a01](https://github.com/handleui/forks/commit/6ed8a01d9e9689fb68f444ba2febd008154d97b2))
* environment profile management and workspace setup automation ([#22](https://github.com/handleui/forks/issues/22)) ([33813dc](https://github.com/handleui/forks/commit/33813dc1bc725335b34cf33403652814e705a468))
* harden local forksd auth ([77e3840](https://github.com/handleui/forks/commit/77e3840df82560bbfc41796ae31ca0316070f7df))
* implement MCP server integration with store events ([#5](https://github.com/handleui/forks/issues/5)) ([7486802](https://github.com/handleui/forks/commit/7486802bdab53d704d0858a86812a4ef9bbf64e1))
* implement permission request approval backend ([#15](https://github.com/handleui/forks/issues/15)) ([cdf274c](https://github.com/handleui/forks/commit/cdf274ce7c4d64e716a035568eaca3fd27007b97))
* implement runner integration with Codex adapter ([#10](https://github.com/handleui/forks/issues/10)) ([a60b086](https://github.com/handleui/forks/commit/a60b08699e0194d307f0ee0c610bded6d12c1334))
* implement workspace and project management with git worktrees ([7eb8c92](https://github.com/handleui/forks/commit/7eb8c921eb078980461a8404db3311bd48c939fa))
* implement workspace and project management with git worktrees ([88cd584](https://github.com/handleui/forks/commit/88cd58426338d0bff7434e8f5705050c419704a9))
* integrate codex manager into forksd ([c24fcec](https://github.com/handleui/forks/commit/c24fcec59cb60a6a242b89ae46998c2e08b852fc))
* integrate codex manager into forksd ([a8c9254](https://github.com/handleui/forks/commit/a8c9254bd304750727f1563c3b6c7195b7734cb7))
* parallel attempts with git worktree isolation ([#21](https://github.com/handleui/forks/issues/21)) ([54ad09a](https://github.com/handleui/forks/commit/54ad09ac520b7ad09247b304d28b30e5caedb7fb))
* **subagent:** add await/list tools and interrupted status ([#26](https://github.com/handleui/forks/issues/26)) ([2fbca18](https://github.com/handleui/forks/commit/2fbca1802fd6c9dc5f27d7b529b57209aa980766))
* **telemetry:** hardcode sentry dsns with opt-out support ([0368d19](https://github.com/handleui/forks/commit/0368d1967e6b4bccacae35674fe5f709ac3bd156))


### Bug Fixes

* **forksd:** terminal closure and security improvements ([#23](https://github.com/handleui/forks/issues/23)) ([411d4df](https://github.com/handleui/forks/commit/411d4df248f55692556df0a9f175e58a59259272))

## [0.2.0](https://github.com/handleui/forks/compare/v0.1.0...v0.2.0) (2026-01-29)


### Features

* add baseInstructions support and skill loading utilities ([#8](https://github.com/handleui/forks/issues/8)) ([4799f2a](https://github.com/handleui/forks/commit/4799f2a92deada3eeb20fd011716d2da9212dc42))
* add codex chatgpt authentication support ([#4](https://github.com/handleui/forks/issues/4)) ([a58d2ef](https://github.com/handleui/forks/commit/a58d2efaec6df34a6ae955b124e28efbfcb86ae5))
* add collaboration mode support for plan vs execute workflows ([#24](https://github.com/handleui/forks/issues/24)) ([31a6d3f](https://github.com/handleui/forks/commit/31a6d3fd5d018825d4ad9cdee946e3e6afbfa447))
* add graphite stack management tools and events ([#20](https://github.com/handleui/forks/issues/20)) ([60916e6](https://github.com/handleui/forks/commit/60916e6404d7cf7411ddf1a90c76a0a18a9b90a2))
* add task-plan linking and enhanced task management ([#18](https://github.com/handleui/forks/issues/18)) ([39ff01a](https://github.com/handleui/forks/commit/39ff01a756a1e2d5bef88846fcc4cf441da678d1))
* **codex:** add process exit handling, restart, and source detection ([#25](https://github.com/handleui/forks/issues/25)) ([f8d5334](https://github.com/handleui/forks/commit/f8d53340453d638a972dbdd482718e20171a54ed))
* dsn passed to daemon ([a24e704](https://github.com/handleui/forks/commit/a24e704098963c97704658753d7440fd40abb021))
* enhance sentry error tracking and release automation ([#13](https://github.com/handleui/forks/issues/13)) ([6ed8a01](https://github.com/handleui/forks/commit/6ed8a01d9e9689fb68f444ba2febd008154d97b2))
* environment profile management and workspace setup automation ([#22](https://github.com/handleui/forks/issues/22)) ([33813dc](https://github.com/handleui/forks/commit/33813dc1bc725335b34cf33403652814e705a468))
* harden local forksd auth ([77e3840](https://github.com/handleui/forks/commit/77e3840df82560bbfc41796ae31ca0316070f7df))
* implement MCP server integration with store events ([#5](https://github.com/handleui/forks/issues/5)) ([7486802](https://github.com/handleui/forks/commit/7486802bdab53d704d0858a86812a4ef9bbf64e1))
* implement permission request approval backend ([#15](https://github.com/handleui/forks/issues/15)) ([cdf274c](https://github.com/handleui/forks/commit/cdf274ce7c4d64e716a035568eaca3fd27007b97))
* implement runner integration with Codex adapter ([#10](https://github.com/handleui/forks/issues/10)) ([a60b086](https://github.com/handleui/forks/commit/a60b08699e0194d307f0ee0c610bded6d12c1334))
* implement workspace and project management with git worktrees ([7eb8c92](https://github.com/handleui/forks/commit/7eb8c921eb078980461a8404db3311bd48c939fa))
* implement workspace and project management with git worktrees ([88cd584](https://github.com/handleui/forks/commit/88cd58426338d0bff7434e8f5705050c419704a9))
* integrate codex manager into forksd ([c24fcec](https://github.com/handleui/forks/commit/c24fcec59cb60a6a242b89ae46998c2e08b852fc))
* integrate codex manager into forksd ([a8c9254](https://github.com/handleui/forks/commit/a8c9254bd304750727f1563c3b6c7195b7734cb7))
* parallel attempts with git worktree isolation ([#21](https://github.com/handleui/forks/issues/21)) ([54ad09a](https://github.com/handleui/forks/commit/54ad09ac520b7ad09247b304d28b30e5caedb7fb))
* **subagent:** add await/list tools and interrupted status ([#26](https://github.com/handleui/forks/issues/26)) ([2fbca18](https://github.com/handleui/forks/commit/2fbca1802fd6c9dc5f27d7b529b57209aa980766))
* **telemetry:** hardcode sentry dsns with opt-out support ([0368d19](https://github.com/handleui/forks/commit/0368d1967e6b4bccacae35674fe5f709ac3bd156))


### Bug Fixes

* **forksd:** terminal closure and security improvements ([#23](https://github.com/handleui/forks/issues/23)) ([411d4df](https://github.com/handleui/forks/commit/411d4df248f55692556df0a9f175e58a59259272))

## 0.1.0

### Minor Changes

- a60b086: Integrate runner to execute subagents and attempt batches via MCP tools.
  The spawn and cancel tool handlers now delegate to the runner for actual Codex execution.
  Adds graceful runner shutdown on process termination.

### Patch Changes

- Updated dependencies [4799f2a]
- Updated dependencies [a60b086]
- Updated dependencies [4799f2a]
- Updated dependencies [a60b086]
  - @forks-sh/skills@0.1.0
  - @forks-sh/store@0.1.1
  - @forks-sh/codex@0.1.0
  - @forks-sh/runner@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [88cd584]
- Updated dependencies [88cd584]
- Updated dependencies [88cd584]
  - @forks-sh/protocol@0.1.0
  - @forks-sh/store@0.1.0
  - @forks-sh/git@0.1.0
