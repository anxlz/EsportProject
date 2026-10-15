import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ROLE_TEMPLATES,
  GRANTABLE_PERMISSION_KEYS,
  PERMISSIONS,
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
} from './permissions';
import { roleInputSchema } from './schemas';

describe('permission catalog', () => {
  test('every key is namespaced by a known domain', () => {
    for (const key of PERMISSION_KEYS) {
      expect(PERMISSION_DOMAINS).toContain(PERMISSIONS[key].domain);
      expect(key).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
  });

  test('exactly one default template grants everything, and it lists no explicit keys', () => {
    const all = DEFAULT_ROLE_TEMPLATES.filter((t) => t.grantsAll);
    expect(all).toHaveLength(1);
    expect(all[0]!.permissions).toHaveLength(0);
  });

  test('default non-owner templates only use grantable (non owner-only) keys', () => {
    for (const t of DEFAULT_ROLE_TEMPLATES.filter((r) => !r.grantsAll)) {
      for (const p of t.permissions) {
        expect(GRANTABLE_PERMISSION_KEYS).toContain(p);
      }
      expect(new Set(t.permissions).size).toBe(t.permissions.length);
    }
  });

  test('every default template has both English and Arabic names', () => {
    for (const t of DEFAULT_ROLE_TEMPLATES) {
      expect(t.nameEn.length).toBeGreaterThan(0);
      expect(t.nameAr.length).toBeGreaterThan(0);
    }
  });

  test('role input schema rejects owner-only permissions', () => {
    const res = roleInputSchema.safeParse({ nameEn: 'X', permissions: ['roles.manage'] });
    expect(res.success).toBe(false);
  });

  test('role input schema requires a name in at least one language', () => {
    expect(roleInputSchema.safeParse({ permissions: [] }).success).toBe(false);
    expect(roleInputSchema.safeParse({ nameAr: 'مدرب', permissions: [] }).success).toBe(true);
  });
});
