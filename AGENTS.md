# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Commands

- `bun run build` — build all (Turborepo)
- `bun run dev` — `turbo run dev`
- `bun run typecheck` — `turbo run typecheck`
- `bun run check-types` — TypeScript validation
- `bun run check` — `ultracite check`
- `bun run fix` — `ultracite fix` (run before committing)
- `bun x ultracite fix` / `bun x ultracite check` / `bun x ultracite doctor` — direct Ultracite

Single app: `turbo dev --filter=web|desktop|forksd`

## Tech Stack

- **Runtime**: Bun, Node.js ≥18
- **Monorepo**: Turborepo
- **Web**: Next.js
- **Desktop**: Electron + Vite
- **Daemon**: forksd (Node, Hono, MCP, WebSocket, node-pty)
- **Linting**: Biome via Ultracite
- **Versioning**: Changesets
- **Packages**: `@forks-sh/*` (config, git, protocol, runner, skills, store, typescript-config, ui)

## Project Structure

```
apps/
├── desktop/  # Electron app (Vite renderer + main process)
├── forksd/   # Daemon: MCP, HTTP, WebSocket, PTY
└── web/      # Next.js app

packages/
├── config/           # App config
├── git/              # Git operations
├── protocol/         # Shared types and wire format
├── runner/           # Task execution
├── skills/           # Skills/runtime
├── store/            # Persistence
├── typescript-config/# Shared tsconfig presets
└── ui/               # Shared React components
```

## Boundaries

### Always Do

- When answering questions involving external documentation, APIs, or specifications, prefer using Nia MCP tools to retrieve and verify information before responding. Use reasoning first to determine whether external grounding is necessary.  
- Run `bun run fix` before committing

### Ask First

- Changes to MCP tools/resources in forksd
- Changes to `@forks-sh/protocol` or forksd HTTP/PTY contracts
- Changes to `@forks-sh/store` persistence

### Never Do

- Commit without running `bun run fix`

## Style (Project-Specific Only)

Biome handles all standard linting. These are project-specific deviations:

- **Files**: kebab-case (e.g., `user-profile.tsx`)
- **Types**: Prefer interfaces over type aliases; use `type` keyword for type-only imports
- **Functions**: Arrow functions only
- **Comments**: None unless critical; prefix hacks with `// HACK: reason`

## Environment Files

Convention (see `.gitignore`):
- `.env` — Template with placeholder values (COMMITTED, serves as documentation)
- `.env.development`, `.env.production`, etc. — Real credentials (GITIGNORED via `.env.*`)

To set up: copy `.env` to `.env.development` and fill in real values.

## Git

**Conventional Commits (Required)** — Commits are validated by commitlint.

Format: `<type>(<scope>): <description>`

Types:
- `feat` — New feature (minor version bump)
- `fix` — Bug fix (patch version bump)
- `docs` — Documentation only
- `style` — Formatting, no code change
- `refactor` — Code change that neither fixes nor adds
- `perf` — Performance improvement
- `test` — Adding/updating tests
- `build` — Build system or dependencies
- `chore` — Misc tasks (no production code)
- `ci` — CI configuration
- `revert` — Revert a previous commit

Breaking changes: Add `!` after type/scope (e.g., `feat!: remove deprecated API`) for major version bumps.

Rules:
- Header only, no body/footer
- Lowercase type and description
- No period at end
- Max 72 chars

## Plan Mode

- Extremely concise plans. Sacrifice grammar for brevity.
- End with unresolved questions if any.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bun x ultracite fix` before committing to ensure compliance.
