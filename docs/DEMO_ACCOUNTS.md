# Demo Accounts

Created by the seed script: [`server/src/seed.ts`](../server/src/seed.ts) (function `seedUsers`, lines 76-100).

Recreate them with:

```bash
npm run seed
```

The login page ([`web/src/login/LoginPage.tsx`](../web/src/login/LoginPage.tsx), `demoAccounts`) has matching
prefill buttons, and the same three accounts are mirrored as an in-memory fallback in
`seedUsers()` in [`server/src/api/auth.ts`](../server/src/api/auth.ts) when no database is attached.

## Accounts

| Role | Username | Email | Password | Card no. | PIN |
|---|---|---|---|---|---|
| reader (`reader-001`, 林知秋) | `R-2048` | `reader.demo@library.local` | `reader123` | `20240001` | none |
| librarian (`librarian-001`, 馆员值班台) | `librarian` | `librarian@library.local` | `librarian123` | — | none |
| admin (`admin-001`, 系统管理员) | `admin` | `admin@library.local` | `admin123` | — | none |

There is no PIN field in the schema or the login flow. Readers authenticate either with the
username/email + password pair or by card number only through `POST /api/auth/card-login`.

## Bulk reader accounts

The seed also creates 59 additional readers, `reader-002` through `reader-060`:

- Username: `R-20240002` … `R-20240060`
- Email: `reader2@library.local` … `reader60@library.local`
- Password: `reader123` (all of them)
- Card no.: identical to the username suffix, `20240002` … `20240060`
- About 4% of them are seeded with `status: "suspended"` rather than `"active"`.

## Logging in

```bash
# role + account + password
curl -s -X POST localhost:3001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"role":"admin","account":"admin","password":"admin123"}'

# reader card only
curl -s -X POST localhost:3001/api/auth/card-login \
  -H 'content-type: application/json' \
  -d '{"cardNumber":"20240001"}'
```

The response sets an `HttpOnly` session cookie (`ul_session`) valid for 8 hours, or 14 days when
`"remember": true` is passed. The role must match the account: an `admin` login with
`account: "librarian"` is rejected.
