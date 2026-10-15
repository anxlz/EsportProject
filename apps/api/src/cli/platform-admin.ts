/**
 * Grant or revoke platform-admin (super-admin) status. Intentionally CLI-only: there is no HTTP
 * endpoint that can create a platform admin, so no tenant permission can ever reach this tier.
 *
 *   bun run platform-admin grant someone@example.com
 *   bun run platform-admin revoke someone@example.com
 *   bun run platform-admin list
 */
import { eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { auditLogs, platformAdmins, users } from '../db/schema';

const [command, email] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const { db, sql: conn } = createDb(url, { prepare: true, max: 1 });

try {
  if (command === 'list') {
    const rows = await db
      .select({ email: users.email, grantedAt: platformAdmins.grantedAt })
      .from(platformAdmins)
      .innerJoin(users, eq(users.id, platformAdmins.userId));
    console.table(rows);
  } else if ((command === 'grant' || command === 'revoke') && email) {
    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    if (!user) throw new Error(`No user with email ${email}. They must have an account first.`);
    if (command === 'grant') {
      await db
        .insert(platformAdmins)
        .values({ userId: user.id, note: 'granted via CLI' })
        .onConflictDoNothing();
    } else {
      await db.delete(platformAdmins).where(eq(platformAdmins.userId, user.id));
    }
    await db.insert(auditLogs).values({
      organizationId: null,
      actorUserId: null,
      actorType: 'system',
      action: command === 'grant' ? 'platform.admin_granted' : 'platform.admin_revoked',
      targetType: 'user',
      targetId: user.id,
      metadata: { via: 'cli' },
    });
    console.log(`${command === 'grant' ? 'Granted' : 'Revoked'} platform admin for ${user.email}`);
  } else {
    console.log('Usage: platform-admin <grant|revoke> <email> | platform-admin list');
    process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
