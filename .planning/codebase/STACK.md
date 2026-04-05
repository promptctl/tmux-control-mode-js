# Technology Stack

**Analysis Date:** 2026-04-05

## Languages

**Primary:**
- TypeScript 5.9.3 - Full codebase, strict mode enabled

**Secondary:**
- JavaScript (compiled output target: ES2022)

## Runtime

**Environment:**
- Node.js 20+ (specified in `engines`)

**Package Manager:**
- npm (lockfile: `package-lock.json` present)

## Frameworks

**Core:**
- None - Library only (no web framework, no backend framework)

**Testing:**
- Vitest 4.1.0 - Test runner and assertion library
  - Config: `vitest.config.ts`
  - Globals enabled (no need for explicit imports)
  - Scans: `src/**/*.test.ts`, `tests/unit/**/*.test.ts`, `tests/integration/**/*.test.ts`

**Build/Dev:**
- TypeScript Compiler (tsc) - Build and type-checking
  - Project references: `src/protocol`, `src/transport`, `src`
  - ES modules (type: "module" in package.json)

## Key Dependencies

**Zero Runtime Dependencies:**
- The library has NO production dependencies
- All functionality uses only Node.js built-in modules

**Development Dependencies (runtime-relevant):**
- `@types/node` 22.0.0 - Type definitions for Node.js APIs
  - Used by `src/transport` for `child_process` types

## Configuration

**TypeScript:**
- Base config: `tsconfig.base.json`
  - Target: ES2022
  - Module: NodeNext (ES module support)
  - Strict mode: enabled
  - Declaration maps: enabled (for IDE support)
  - Source maps: enabled
- Project references in root `tsconfig.json`:
  - `src/protocol` (protocol/types definitions only)
  - `src/transport` (Node.js-dependent spawn implementation)
  - `src` (main entry point and client)

**Code Quality:**
- Prettier (3.8.1) - Code formatting
  - Config: `.prettierrc`
  - Semi: true
  - Single quotes: false
  - Trailing commas: all
  - Print width: 80
  - Tab width: 2

- ESLint (10.1.0) + TypeScript ESLint - Linting
  - Config: `eslint.config.ts` (new flat config format)
  - Recommended + strict + stylistic rules
  - Consistent type imports enforced
  - Unused variable detection (ignores `_` prefix)

## Module System

**Output:**
- TypeScript compiles to ES modules (`.js` files)
- Entry point exports:
  - Default: `dist/index.js` (types: `dist/index.d.ts`)
  - Named exports: `./protocol`, `./terminal` subpath exports
- Side effects: false (tree-shakeable)

## Build Process

**Build command:** `tsc --build`
- Compiles all project references in correct dependency order
- Outputs to `dist/` directory

**Development:** `tsc --build --watch`
- Watch mode for incremental compilation

**Cleaning:** `tsc --build --clean`
- Removes generated dist files

**Pre-publish:** `npm run build` executed automatically before publishing

## Testing

**Test Commands:**
```bash
npm test              # Run all tests once
npm run test:watch   # Watch mode
```

**Test Files Location:**
- Unit tests: `tests/unit/**/*.test.ts` and `src/**/*.test.ts`
- Integration tests: `tests/integration/**/*.test.ts`
- Vitest provides globals (describe, it, expect) automatically

## Platform Requirements

**Development:**
- Node.js 20+
- npm (any recent version)
- Bash/shell for scripts

**Production:**
- Node.js 20+ runtime
- Access to `tmux` binary on the system
- stdio pipes available (child process stdio)

## Environment Variables

No environment variables are required. Configuration is passed programmatically to:
- `spawnTmux(args, { tmuxPath?, socketPath?, env?, controlControl? })` via options object
- `TmuxClient` operations via method arguments

---

*Stack analysis: 2026-04-05*
