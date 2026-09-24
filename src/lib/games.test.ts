import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllGames,
    getAllCategories,
    getAllPublishers,
    getAllGameIds,
    getGameById,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('filters games by one or more categories and a publisher', async () => {
        const [strategy, puzzle] = await db
            .insert(categories)
            .values([
                { name: 'Strategy', description: 'strategy' },
                { name: 'Puzzle', description: 'puzzle' },
            ])
            .returning({ id: categories.id, name: categories.name });
        const [firstPublisher, secondPublisher] = await db
            .insert(publishers)
            .values([
                { name: 'Alpha Games', description: 'alpha' },
                { name: 'Beta Games', description: 'beta' },
            ])
            .returning({ id: publishers.id, name: publishers.name });

        await db.insert(games).values([
            {
                title: 'Puzzle Alpha',
                description: 'Puzzle',
                starRating: 4,
                categoryId: puzzle.id,
                publisherId: firstPublisher.id,
            },
            {
                title: 'Strategy Alpha',
                description: 'Strategy',
                starRating: 4,
                categoryId: strategy.id,
                publisherId: firstPublisher.id,
            },
            {
                title: 'Strategy Beta',
                description: 'Strategy',
                starRating: 4,
                categoryId: strategy.id,
                publisherId: secondPublisher.id,
            },
        ]);

        expect((await getAllGames(db, { categoryIds: [strategy.id] })).map((g) => g.title)).toEqual([
            'Strategy Alpha',
            'Strategy Beta',
        ]);
        expect((await getAllGames(db, { categoryIds: [strategy.id, puzzle.id] })).map((g) => g.title)).toEqual([
            'Puzzle Alpha',
            'Strategy Alpha',
            'Strategy Beta',
        ]);
        expect(
            (await getAllGames(db, {
                categoryIds: [strategy.id],
                publisherId: secondPublisher.id,
            })).map((g) => g.title),
        ).toEqual(['Strategy Beta']);
    });

    it('returns no games when filters do not match', async () => {
        await seedGames(db, 2);
        expect(await getAllGames(db, { categoryIds: [99999] })).toEqual([]);
    });

    it('returns filter options ordered by name', async () => {
        await db.insert(categories).values([
            { name: 'Zeta', description: 'z' },
            { name: 'Alpha', description: 'a' },
        ]);
        await db.insert(publishers).values([
            { name: 'Zeta Press', description: 'z' },
            { name: 'Alpha Press', description: 'a' },
        ]);

        expect((await getAllCategories(db)).map((item) => item.name)).toEqual(['Alpha', 'Zeta']);
        expect((await getAllPublishers(db)).map((item) => item.name)).toEqual([
            'Alpha Press',
            'Zeta Press',
        ]);
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });
});
