import type { Database } from '@/server/db'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { sql } from 'kysely'

import { FriendshipStatusSchema } from '@/utils/server/friendship-schemas'
import { protectedProcedure } from '@/server/trpc/procedures'
import { router } from '@/server/trpc/router'
import {
  NonEmptyStringSchema,
  CountSchema,
  IdSchema,
} from '@/utils/server/base-schemas'

export const myFriendRouter = router({
  getById: protectedProcedure
    .input(
      z.object({
        friendUserId: IdSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.connection().execute(async (conn) =>
        /**
         * Question 4: Implement mutual friend count
         *
         * Add `mutualFriendCount` to the returned result of this query. You can
         * either:
         *  (1) Make a separate query to count the number of mutual friends,
         *  then combine the result with the result of this query
         *  (2) BONUS: Use a subquery (hint: take a look at how
         *  `totalFriendCount` is implemented)
         *
         * Instructions:
         *  - Go to src/server/tests/friendship-request.test.ts, enable the test
         * scenario for Question 3
         *  - Run `yarn test` to verify your answer
         *
         * Documentation references:
         *  - https://kysely-org.github.io/kysely/classes/SelectQueryBuilder.html#innerJoin
         */
        conn
          .selectFrom('users as friends')
          .innerJoin('friendships', 'friendships.friendUserId', 'friends.id')
          .innerJoin(
            userTotalFriendCount(conn).as('userTotalFriendCount'),
            'userTotalFriendCount.userId',
            'friends.id'
          )
          .leftJoin(
            userMutualFriendCount(
              conn,
              ctx.session.userId,
              input.friendUserId
            ).as('userMutualFriendCount'),
            'userMutualFriendCount.user',
            'friends.id'
          )
          .where('friendships.userId', '=', ctx.session.userId)
          .where('friendships.friendUserId', '=', input.friendUserId)
          .where(
            'friendships.status',
            '=',
            FriendshipStatusSchema.Values['accepted']
          )
          .select((eb) => [
            'friends.id',
            'friends.fullName',
            'friends.phoneNumber',
            'totalFriendCount',
            eb.fn
              .coalesce('mutualFriendCount', sql<number>`0`)
              .as('mutualFriendCount'),
          ])
          .executeTakeFirstOrThrow(() => new TRPCError({ code: 'NOT_FOUND' }))
          .then(
            z.object({
              id: IdSchema,
              fullName: NonEmptyStringSchema,
              phoneNumber: NonEmptyStringSchema,
              totalFriendCount: CountSchema,
              mutualFriendCount: CountSchema,
            }).parse
          )
      )
    }),

  getAll: protectedProcedure.mutation(async ({ ctx }) => {
    return ctx.db.connection().execute(async (conn) =>
      conn
        .selectFrom('users as friends')
        .innerJoin('friendships', 'friendships.friendUserId', 'friends.id')
        .innerJoin(
          userTotalFriendCount(conn).as('userTotalFriendCount'),
          'userTotalFriendCount.userId',
          'friends.id'
        )
        .leftJoin(
          mutualFriendsCountAll(conn, ctx.session.userId).as(
            'mutualFriendCount'
          ),
          'mutualFriendCount.user',
          'friends.id'
        )
        .where('friendships.userId', '=', ctx.session.userId)
        .where(
          'friendships.status',
          '=',
          FriendshipStatusSchema.Values['accepted']
        )
        .select([
          'friends.id',
          'friends.fullName',
          'friends.phoneNumber',
          'totalFriendCount',
          'mutualFriendCount',
        ])
        .execute()
        .then(
          z.array(
            z.object({
              id: IdSchema,
              fullName: NonEmptyStringSchema,
              phoneNumber: NonEmptyStringSchema,
              totalFriendCount: CountSchema,
              mutualFriendCount: CountSchema,
            })
          ).parse
        )
    )
  }),

  getAll1: protectedProcedure.mutation(async ({ ctx }) => {
    return ctx.db.connection().execute(async (conn) =>
      conn
        .with('userFriendships', (db) =>
          db
            .selectFrom('friendships')
            .where(
              'friendships.status',
              '=',
              FriendshipStatusSchema.Values['accepted']
            )
            .where('friendships.userId', '=', ctx.session.userId)
            .select(['friendships.userId', 'friendships.friendUserId'])
        )
        .with('friendsFriendships', (db) =>
          db
            .selectFrom('friendships')
            .where(
              'friendships.status',
              '=',
              FriendshipStatusSchema.Values['accepted']
            )
            .where('friendships.userId', '!=', ctx.session.userId)
            .select(['friendships.userId', 'friendships.friendUserId'])
        )
        .with('mutualFriendCount', (db) =>
          db
            .selectFrom('userFriendships as f1')
            .innerJoin('friendsFriendships as f2', (join) =>
              join.onRef('f1.friendUserId', '=', 'f2.friendUserId')
            )
            .select((eb) => [
              'f1.userId as user',
              'f2.userId as friend',
              eb.fn.countAll().as('mutualFriendCount'),
            ])
            .groupBy(['f1.userId', 'f2.userId'])
        )
        .selectFrom('users as friends')
        .innerJoin(
          'friendsFriendships',
          'friendsFriendships.userId',
          'friends.id'
        )
        .leftJoin('mutualFriendCount', 'mutualFriendCount.friend', 'friends.id')
        .select((eb) => [
          'friends.id',
          'friends.fullName',
          'friends.phoneNumber',
          eb.fn.count('friendsFriendships.friendUserId').as('totalFriendCount'),
          'mutualFriendCount',
        ])
        .groupBy('friends.id')
        .execute()
        .then(
          z.array(
            z.object({
              id: IdSchema,
              fullName: NonEmptyStringSchema,
              phoneNumber: NonEmptyStringSchema,
              totalFriendCount: CountSchema,
              mutualFriendCount: CountSchema,
            })
          ).parse
        )
    )
  }),
})

const userTotalFriendCount = (db: Database) => {
  return db
    .selectFrom('friendships')
    .where('friendships.status', '=', FriendshipStatusSchema.Values['accepted'])
    .select((eb) => [
      'friendships.userId',
      eb.fn.count('friendships.friendUserId').as('totalFriendCount'),
    ])
    .groupBy('friendships.userId')
}

const userMutualFriendCount = (
  db: Database,
  userId: number,
  friendUserId: number
) => {
  return db
    .selectFrom('friendships as f1')
    .innerJoin('friendships as f2', 'f1.friendUserId', 'f2.friendUserId')
    .where('f1.status', '=', FriendshipStatusSchema.Values['accepted'])
    .where('f2.status', '=', FriendshipStatusSchema.Values['accepted'])
    .where('f1.userId', '=', friendUserId)
    .where('f2.userId', '=', userId)
    .select((eb) => [
      'f1.userId as user',
      'f2.userId as friend',
      eb.fn.countAll().as('mutualFriendCount'),
    ])
    .groupBy(['f1.userId', 'f2.userId'])
}

const mutualFriendsCountAll = (db: Database, userId: number) => {
  return db
    .selectFrom('friendships as f1')
    .innerJoin('friendships as f2', (join) =>
      join
        .onRef('f1.friendUserId', '=', 'f2.friendUserId')
        .onRef('f1.userId', '<>', 'f2.userId')
        .on('f2.userId', '=', userId)
    )
    .where('f1.status', '=', FriendshipStatusSchema.Values['accepted'])
    .where('f2.status', '=', FriendshipStatusSchema.Values['accepted'])
    .select((eb) => [
      'f1.userId as user',
      'f2.userId as friend',
      eb.fn.countAll().as('mutualFriendCount'),
    ])
    .groupBy(['f1.userId', 'f2.userId'])
}
