---
description: 'Drizzle ORM + Node SQLite data layer patterns for the Astro app'
applyTo: 'db/**/*.ts,src/lib/*.ts'
---

# Drizzle ORM + Node SQLite Instructions

The app's data lives in a local SQLite database accessed through **Drizzle ORM** over Node.js's built-in `node:sqlite` driver. It is consumed at **build time** from Astro page frontmatter — there is no runtime API server. Schema changes are managed with **drizzle-kit** migrations.

## Layout

- `db/schema.ts` — Drizzle table definitions (`publishers`, `categories`, `games`) and inferred row types. The single source of truth for the schema.
- `db/transforms.ts` — **pure** functions (CSV parsing, description building, de-duplication, deterministic `ratingFromTitle`). No DB access — easy to unit test.
- `db/seed.ts` — idempotent seeding from `db/games.csv` using the transforms.
- `db/migrate.ts` — applies generated migrations.
- `db/migrations/` — generated SQL migrations (do not hand-edit).
- `db/test-helpers.ts` — `createTestDatabase()` returns a migrated in-memory Node SQLite db for tests.
- `src/lib/db.ts` — `createDatabase(url)` / `getDatabase()` build the Drizzle client from `DATABASE_URL` (defaults to the local `tailspin.db` file).
- `src/lib/games.ts` — typed, **injectable-db** data-access helpers used by pages and tests.

## Schema Conventions

- Use `sqliteTable` with explicit column names (`text`, `integer`, `real`).
- Primary keys: `integer('id').primaryKey({ autoIncrement: true })`.
- Mark required columns `.notNull()`; nullable columns (e.g. `starRating`) are left nullable.
- Foreign keys use `.references(() => other.id)`.
- Export inferred types (`typeof table.$inferSelect`) and build app-facing types from them — don't redeclare row shapes by hand.

## Migrations Workflow

1. Edit `schema.ts`.
2. Generate a migration: `npm run db:generate` (drizzle-kit).
3. Apply + seed locally: `npm run db:setup` (`db:migrate` + `db:seed`).
4. Commit both the schema change **and** the generated migration in `db/migrations/`.

> [!IMPORTANT]
> The database must be migrated and seeded **before** `astro build`. The `prebuild`/`predev` npm scripts run `db:setup` automatically; CI relies on this ordering.

## Data-Access Helpers (injectable db)

Helpers take the `db` instance as their first argument so they work both with the real client (in pages) and an in-memory client (in tests):

```ts
import { asc, count, eq } from 'drizzle-orm';
import type { Database } from './db';
import { games } from '../../db/schema';

export async function getAllGameIds(db: Database): Promise<number[]> {
  const rows = await db.select({ id: games.id }).from(games).orderBy(asc(games.title));
  return rows.map((r) => r.id);
}
```

### Exported API documentation

- Every exported function in `db/**/*.ts` and `src/lib/*.ts` must have a TSDoc/JSDoc comment immediately above it.
- The comment must describe the function's purpose, every parameter (including the injectable `db` parameter), and the returned value. Use `@param` and `@returns` tags when they make the contract clearer.
- Keep the injectable `db` argument explicit in both the signature and its documentation so the production-versus-test boundary remains clear.
- Document important ordering, nullability, determinism, and error behavior when callers rely on it.
- Do not use comments to paraphrase SQL, a straightforward mapping, or the function name. Explain intent and constraints instead.
- Update or remove comments in the same change as the code they describe; stale documentation is a correctness issue.

```ts
/**
 * Returns all games in stable title order for deterministic static pages.
 * @param db The injectable database used for the query.
 * @returns The game IDs ordered by title.
 */
export async function getAllGameIds(db: Database): Promise<number[]> {
  // ...
}
```

- Always `order by` a stable column (title) so static builds are deterministic.
- Map raw rows to the app-facing `Game`/`Publisher`/`Category` types in one place; don't leak Drizzle row shapes into components.
- Keep ordering/lookup logic in `games.ts`, not in pages.

## Determinism

Seed-derived values must be reproducible across builds. Derive star ratings from a stable hash of the title (`ratingFromTitle`) — **never** `Math.random()`.

## Testing

Unit-test transforms directly and helpers against `createTestDatabase()`. See [`unit-tests.instructions.md`](unit-tests.instructions.md).

## Node.js requirement

Node.js 22.13 or later is required because the data layer uses the built-in `node:sqlite` module without an experimental flag. Do not introduce third-party SQLite drivers that ship platform-specific binaries.

## Type checking

The data layer (`db/**/*.ts`, `src/lib/*.ts`) is type-checked by `npm run typecheck`, which runs the native **TypeScript 7** compiler (`tsgo`, from `@typescript/native-preview`) against `tsconfig.tsgo.json`. Keep helpers exported with explicit parameter and return types so `tsgo` can verify them. Linting is unaffected — ESLint + `typescript-eslint` still run on the classic `typescript` package.

## Comments and formatting

- Prefer TSDoc/JSDoc for exported APIs; use inline comments only for non-obvious intent or decisions.
- Follow the repository TypeScript formatting rules: single quotes, semicolons, and trailing commas in multiline structures. ESLint enforces the quote and semicolon rules for TypeScript files.
