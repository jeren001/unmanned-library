# HTTP API and SSE Contract

This file is the source of truth for the API implemented by `/server`. Examples
show representative JSON; generated IDs, timestamps, and counts vary.

## Conventions

- Base URL: `http://localhost:3001`.
- Auth uses the `HttpOnly` `ul_session` cookie.
- Roles: `public`, `reader`, `librarian`, `admin`. `operate` means
  `reader/librarian/admin`; `manage` means `librarian/admin`.
- Most successful domain responses are wrapped as `{ "data": ... }`.
- Status values: `implemented`, `partial`, `missing`.

## Error Format

Authenticated-route errors:

```json
{ "error": "UNAUTHENTICATED" }
```

```json
{ "error": "FORBIDDEN" }
```

Validation error:

```json
{
  "code": "INVALID_INPUT",
  "message": "Request body is invalid.",
  "details": {
    "formErrors": [],
    "fieldErrors": {}
  }
}
```

Query validation uses code `INVALID_QUERY`. Domain errors use:

```json
{
  "code": "BOOK_UNAVAILABLE",
  "message": "Book is not available",
  "details": null
}
```

Domain errors ending in `NOT_FOUND` return `404`; other domain errors return
`409`. Unique constraint failures return:

```json
{
  "code": "CONFLICT",
  "message": "The request conflicts with existing data.",
  "details": "UNIQUE constraint failed: ..."
}
```

Unexpected route failures return:

```json
{
  "code": "INTERNAL_ERROR",
  "message": "The server could not complete the request.",
  "details": null
}
```

Auth routes also use compact errors such as `{ "error": "INVALID_INPUT" }`,
`{ "error": "RATE_LIMITED", "message": "Too many attempts. Please wait a minute." }`,
and credential errors that include both `code` and `error`.

## Endpoints

### `GET /api/health`

- **Role:** public
- **Request:** no body
- **Response:**

```json
{ "status": "ok" }
```

- **Errors:** none defined by route
- **Status:** implemented

### `GET /api/public/stats`

- **Role:** public
- **Request:** no body
- **Response:**

```json
{
  "branchesLive": 3,
  "devicesOnline": 24,
  "loansToday": 5,
  "branchNetwork": "connected",
  "version": "v0.1.0"
}
```

- **Errors:** none defined by route
- **Status:** partial; login-page stats only

### `POST /api/auth/login`

- **Role:** public
- **Request:**

```json
{
  "role": "reader",
  "account": "R-2048",
  "password": "reader123",
  "remember": false
}
```

- **Response:**

```json
{
  "user": {
    "id": "reader-001",
    "role": "reader",
    "name": "林知秋",
    "account": "R-2048",
    "landingPath": "/kiosk"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401 INVALID_CREDENTIALS`, `423 ACCOUNT_LOCKED`, `429 RATE_LIMITED`
- **Status:** implemented

### `POST /api/auth/card-login`

- **Role:** public
- **Request:**

```json
{ "cardNumber": "20240001" }
```

- **Response:**

```json
{
  "user": {
    "id": "reader-001",
    "role": "reader",
    "name": "林知秋",
    "account": "R-2048",
    "landingPath": "/kiosk"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401 INVALID_CARD`, `429 RATE_LIMITED`
- **Status:** partial; card login exists, QR login does not

### `GET /api/auth/me`

- **Role:** public
- **Request:** optional session cookie; no body
- **Response:**

```json
{
  "user": {
    "id": "admin-001",
    "role": "admin",
    "name": "系统管理员",
    "account": "admin",
    "landingPath": "/admin"
  }
}
```

Unauthenticated response:

```json
{ "user": null }
```

- **Errors:** none defined by route
- **Status:** implemented

### `POST /api/auth/logout`

- **Role:** public
- **Request:** optional session cookie; no body
- **Response:** `204 No Content`; clears `ul_session`
- **Errors:** none defined by route
- **Status:** implemented

### `GET /api/books`

- **Role:** operate
- **Request:** `GET /api/books?branchId=branch-east&status=on_shelf&q=RFID&limit=20&offset=0`
- **Response:**

```json
{
  "data": [
    {
      "id": "book-0001",
      "isbn": "978-7-100001-1",
      "title": "无人值守系统设计（第 2 版）",
      "author": "陈墨",
      "category": "TP201",
      "branch_id": "branch-east",
      "shelf_location": "EAST-B-02",
      "edition": "2 edition",
      "purchased_at": "2026-01-01T09:00:00.000Z",
      "rfid_tag": "RFID-000001",
      "status": "on_shelf",
      "cover_color": "#1F4D3A"
    }
  ]
}
```

- **Errors:** `401`, `403`, `400 INVALID_QUERY`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/books`

- **Role:** manage
- **Request:**

```json
{
  "isbn": "978-7-100001-1",
  "title": "无人值守系统设计（第 2 版）",
  "author": "陈墨",
  "category": "TP201",
  "branch_id": "branch-east",
  "shelf_location": "EAST-B-02",
  "edition": "2 edition",
  "purchased_at": "2026-10-10T00:00:00.000Z",
  "rfid_tag": "RFID-NEW-0001",
  "status": "on_shelf",
  "cover_color": "#1F4D3A"
}
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "isbn": "978-7-100001-1",
    "title": "无人值守系统设计（第 2 版）",
    "status": "on_shelf"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `409 CONFLICT`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `PATCH /api/books/:id`

- **Role:** manage
- **Request:**

```json
{ "shelf_location": "EAST-C-12", "status": "repair" }
```

- **Response:**

```json
{
  "data": {
    "id": "book-0001",
    "shelf_location": "EAST-C-12",
    "status": "repair",
    "updated_at": "2026-10-10T00:00:00.000Z"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 NOT_FOUND`, `409`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/books/:id`

- **Role:** operate
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "id": "book-0001",
    "isbn": "978-7-100001-1",
    "title": "无人值守系统设计（第 2 版）",
    "rfid_tag": "RFID-000001",
    "status": "on_shelf"
  }
}
```

- **Errors:** `401`, `403`, `404 NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/readers`

- **Role:** manage
- **Request:** `GET /api/readers?q=R-2048&status=active&limit=20&offset=0`
- **Response:**

```json
{
  "data": [
    {
      "id": "reader-001",
      "role": "reader",
      "username": "R-2048",
      "email": "reader.demo@library.local",
      "display_name": "林知秋",
      "student_no": "20240001",
      "id_number_masked": "3201********1024",
      "card_no": "20240001",
      "qr_code": "QR-20240001",
      "deposit_cents": 10000,
      "status": "active"
    }
  ]
}
```

- **Errors:** `400 INVALID_QUERY`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/readers`

- **Role:** manage
- **Request:**

```json
{
  "role": "reader",
  "username": "R-2099",
  "email": "reader2099@library.local",
  "password_hash": "pre-hashed-value",
  "display_name": "新读者",
  "student_no": "20240999",
  "id_number_masked": "3201********9999",
  "card_no": "20240999",
  "qr_code": "QR-20240999",
  "deposit_cents": 10000,
  "status": "active"
}
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "role": "reader",
    "username": "R-2099",
    "display_name": "新读者",
    "card_no": "20240999",
    "status": "active"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `409 CONFLICT`, `500 INTERNAL_ERROR`
- **Status:** partial; accepts `password_hash` instead of hashing a password

### `GET /api/readers/:id`

- **Role:** operate
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "id": "reader-001",
    "role": "reader",
    "username": "R-2048",
    "display_name": "林知秋",
    "card_no": "20240001",
    "deposit_cents": 10000,
    "status": "active"
  }
}
```

- **Errors:** `401`, `403`, `404 NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `PATCH /api/readers/:id/status`

- **Role:** manage
- **Request:**

```json
{ "status": "suspended", "locked_until": null }
```

- **Response:**

```json
{
  "data": {
    "id": "reader-001",
    "status": "suspended",
    "locked_until": null
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/loans`

- **Role:** operate; reader requests are scoped to the session user
- **Request:** `GET /api/loans?branchId=branch-east&status=active&limit=20&offset=0`
- **Response:**

```json
{
  "data": [
    {
      "id": "loan-00001",
      "book_id": "book-0001",
      "user_id": "reader-001",
      "branch_id": "branch-east",
      "device_id": "device-east-1",
      "borrowed_at": "2026-10-01T09:00:00.000Z",
      "due_at": "2026-10-31T09:00:00.000Z",
      "returned_at": null,
      "renew_count": 0,
      "status": "active",
      "idempotency_key": "demo-borrow-0001"
    }
  ]
}
```

- **Errors:** `400 INVALID_QUERY`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/loans/borrow`

- **Role:** operate; readers may borrow only for themselves
- **Request:**

```json
{
  "bookId": "book-0001",
  "userId": "reader-001",
  "branchId": "branch-east",
  "deviceId": "device-east-1",
  "idempotencyKey": "demo-borrow-0001"
}
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "book_id": "book-0001",
    "user_id": "reader-001",
    "branch_id": "branch-east",
    "device_id": "device-east-1",
    "status": "active",
    "renew_count": 0,
    "idempotency_key": "demo-borrow-0001"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 BOOK_NOT_FOUND/READER_NOT_FOUND`, `409 BOOK_UNAVAILABLE/MAX_LOANS_REACHED/CONFLICT`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/loans/:id/return`

- **Role:** operate; readers may return only their own loans
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "id": "loan-00001",
    "status": "returned",
    "returned_at": "2026-10-10T10:00:00.000Z"
  }
}
```

- **Errors:** `401`, `403`, `404 LOAN_NOT_FOUND/BOOK_NOT_FOUND`, `409`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/loans/:id/renew`

- **Role:** operate; readers may renew only their own loans
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "id": "loan-00001",
    "status": "active",
    "renew_count": 1,
    "due_at": "2026-11-30T09:00:00.000Z"
  }
}
```

- **Errors:** `401`, `403`, `404 LOAN_NOT_FOUND`, `409 LOAN_NOT_ACTIVE/MAX_RENEWALS_REACHED/LOAN_RESERVED`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/loans/:id/lost`

- **Role:** manage
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "id": "loan-00001",
    "status": "lost"
  }
}
```

- **Errors:** `401`, `403`, `404 LOAN_NOT_FOUND`, `409`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/loans/:id/reminder`

- **Role:** manage
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "user_id": "reader-002",
    "loan_id": "loan-overdue-001",
    "channel": "in_app",
    "message": "图书已逾期，请尽快归还 / Your library loan is overdue. Please return it soon.",
    "status": "queued",
    "created_by": "librarian-001"
  }
}
```

- **Errors:** `401`, `403`, `404 LOAN_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** partial; queues an in-app reminder only

### `GET /api/reservations`

- **Role:** operate; reader requests are scoped to the session user
- **Request:** `GET /api/reservations?status=active&limit=20&offset=0`
- **Response:**

```json
{
  "data": [
    {
      "id": "reservation-001",
      "book_id": "book-0001",
      "user_id": "reader-001",
      "expires_at": "2026-10-13T10:00:00.000Z",
      "status": "active"
    }
  ]
}
```

- **Errors:** `400 INVALID_QUERY`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/reservations`

- **Role:** operate; readers may reserve only for themselves
- **Request:**

```json
{ "bookId": "book-0001", "userId": "reader-001" }
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "book_id": "book-0001",
    "user_id": "reader-001",
    "expires_at": "2026-10-13T10:00:00.000Z",
    "status": "active"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 BOOK_NOT_FOUND`, `409 CONFLICT`, `500 INTERNAL_ERROR`
- **Status:** partial; no cancel/fulfillment flow

### `POST /api/help`

- **Role:** operate
- **Request:**

```json
{
  "branchId": "branch-east",
  "message": "Reader requested remote support."
}
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "branch_id": "branch-east",
    "device_id": null,
    "type": "intrusion",
    "severity": "info",
    "message": "Reader requested remote support.",
    "status": "open",
    "related_loan_id": null,
    "related_clip_id": null
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `409 CONFLICT`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/devices`

- **Role:** `librarian`, `admin`
- **Request:** `GET /api/devices?branchId=branch-east&status=online&limit=50&offset=0`
- **Response:**

```json
{
  "data": [
    {
      "id": "device-east-1",
      "branch_id": "branch-east",
      "kind": "kiosk",
      "name": "East Campus Library kiosk 1",
      "vendor": "MockWorks",
      "protocol": "mock",
      "address": "10.1.0.20",
      "status": "online",
      "last_seen_at": "2026-10-10T10:00:00.000Z",
      "config_json": "{\"samplingIntervalSeconds\":30,\"thresholds\":{}}",
      "config": {
        "samplingIntervalSeconds": 30,
        "thresholds": {}
      }
    }
  ]
}
```

- **Errors:** `400 INVALID_QUERY`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/devices`

- **Role:** `admin`
- **Request:**

```json
{
  "kind": "gate",
  "protocol": "mock",
  "address": "10.1.0.21",
  "branch_id": "branch-east",
  "name": "East gate 2",
  "vendor": "MockWorks",
  "samplingIntervalSeconds": 30,
  "thresholds": {
    "temperature": { "min": 10, "max": 32 },
    "smoke_ppm": { "max": 8 }
  }
}
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "branch_id": "branch-east",
    "kind": "gate",
    "protocol": "mock",
    "address": "10.1.0.21",
    "status": "offline",
    "last_seen_at": null,
    "config_json": "{\"samplingIntervalSeconds\":30,\"thresholds\":{\"temperature\":{\"min\":10,\"max\":32},\"smoke_ppm\":{\"max\":8}}}",
    "config": {
      "samplingIntervalSeconds": 30,
      "thresholds": {
        "temperature": { "min": 10, "max": 32 },
        "smoke_ppm": { "max": 8 }
      }
    }
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `409 CONFLICT`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `PATCH /api/devices/:id/config`

- **Role:** `admin`
- **Request:**

```json
{
  "samplingIntervalSeconds": 60,
  "thresholds": {
    "temperature": { "min": 10, "max": 32 },
    "humidity": { "min": 25, "max": 75 }
  }
}
```

- **Response:**

```json
{
  "data": {
    "id": "device-east-1",
    "status": "online",
    "last_seen_at": "2026-10-10T10:00:00.000Z",
    "config_json": "{\"samplingIntervalSeconds\":60,\"thresholds\":{\"temperature\":{\"min\":10,\"max\":32},\"humidity\":{\"min\":25,\"max\":75}}}",
    "config": {
      "samplingIntervalSeconds": 60,
      "thresholds": {
        "temperature": { "min": 10, "max": 32 },
        "humidity": { "min": 25, "max": 75 }
      }
    }
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 DEVICE_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

Config validation requires `samplingIntervalSeconds` to be an integer from `1`
through `86400`. Threshold entries must contain optional numeric `min` and/or
`max`; if both are provided, `min` must be less than or equal to `max`.

### `POST /api/devices/:id/test-command`

- **Role:** `admin`
- **Request:**

```json
{
  "command": "ping",
  "payload": { "nonce": "abc" }
}
```

- **Response:**

```json
{
  "data": {
    "device": {
      "id": "device-east-1",
      "status": "online",
      "last_seen_at": "2026-10-10T10:00:00.000Z",
      "config": {
        "samplingIntervalSeconds": 60,
        "thresholds": {}
      }
    },
    "result": {
      "ok": true,
      "command": "ping",
      "payload": { "nonce": "abc" },
      "deviceId": "device-east-1"
    }
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 DEVICE_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

The command is sent through the configured `DeviceAdapter`. If the adapter
returns `{ "ok": false }`, the device status is set to `fault`; otherwise the
device status is set to `online` and `last_seen_at` is refreshed.

### `POST /api/devices/:id/health-check`

- **Role:** `admin`
- **Request:** no body
- **Response, healthy adapter:**

```json
{
  "data": {
    "health": {
      "status": "online",
      "latencyMs": 1
    },
    "device": {
      "id": "device-east-1",
      "status": "online",
      "last_seen_at": "2026-10-10T10:00:00.000Z",
      "config": {
        "samplingIntervalSeconds": 60,
        "thresholds": {}
      }
    }
  }
}
```

- **Response, failed adapter:**

```json
{
  "data": {
    "health": {
      "status": "fault",
      "latencyMs": 1,
      "message": "adapter failed"
    },
    "device": {
      "id": "device-east-1",
      "status": "fault",
      "last_seen_at": null
    },
    "alert": {
      "id": "generated-uuid",
      "branch_id": "branch-east",
      "device_id": "device-east-1",
      "type": "device_fault",
      "severity": "warning",
      "message": "Adapter health check failed: adapter failed",
      "status": "open"
    },
    "maintenance": {
      "id": "generated-uuid",
      "branch_id": "branch-east",
      "device_id": "device-east-1",
      "kind": "device_repair",
      "description": "Draft maintenance record: adapter health check failed (fault).",
      "started_at": "2026-10-10T10:00:00.000Z",
      "finished_at": null,
      "operator_id": "admin-001",
      "related_alert_id": "generated-uuid"
    }
  }
}
```

- **Errors:** `401`, `403`, `404 DEVICE_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/alerts`

- **Role:** manage
- **Request:** `GET /api/alerts?branchId=branch-east&type=smoke&severity=critical&status=open&from=2026-10-01T00:00:00.000Z&to=2026-10-10T23:59:59.999Z&limit=50&offset=0`
- **Response:**

```json
{
  "data": [
    {
      "id": "alert-001",
      "branch_id": "branch-east",
      "device_id": "device-east-7",
      "type": "smoke",
      "severity": "critical",
      "message": "smoke_ppm threshold exceeded: 20",
      "status": "open",
      "related_loan_id": null,
      "related_clip_id": "clip-001",
      "device_name": "East Campus Library smoke 7",
      "branch_name": "East Campus Library"
    }
  ]
}
```

- **Errors:** `400 INVALID_QUERY`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

Filters: `branchId`, `type`, `severity`, `status`, `from`, `to`, `limit`,
and `offset`.

### `GET /api/alerts/:id`

- **Role:** manage
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "id": "alert-001",
    "branch_id": "branch-east",
    "device_id": "device-east-7",
    "type": "smoke",
    "severity": "critical",
    "message": "smoke_ppm threshold exceeded: 20",
    "status": "acked",
    "related_clip_id": "clip-001",
    "related_clip_path": "assets/placeholder.mp4",
    "timeline": [
      {
        "kind": "created",
        "actor_id": null,
        "message": "smoke_ppm threshold exceeded: 20",
        "ts": "2026-10-10T10:00:00.000Z"
      },
      {
        "kind": "acked",
        "actor_id": "librarian-001",
        "message": "Alert acknowledged",
        "ts": "2026-10-10T10:01:00.000Z"
      },
      {
        "kind": "note",
        "actor_id": "librarian-001",
        "message": "Checked camera clip.",
        "ts": "2026-10-10T10:02:00.000Z"
      }
    ]
  }
}
```

- **Errors:** `401`, `403`, `404 ALERT_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/alerts`

- **Role:** manage
- **Request:**

```json
{
  "branch_id": "branch-east",
  "device_id": "device-east-7",
  "type": "smoke",
  "severity": "critical",
  "message": "Smoke threshold exceeded.",
  "status": "open",
  "related_loan_id": null,
  "related_clip_id": "clip-001"
}
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "branch_id": "branch-east",
    "device_id": "device-east-7",
    "type": "smoke",
    "severity": "critical",
    "message": "Smoke threshold exceeded.",
    "status": "open"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `409 CONFLICT`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/alerts/:id/ack`

- **Role:** manage
- **Request:**

```json
{ "note": "Investigating camera clip." }
```
- **Response:**

```json
{
  "data": {
    "id": "alert-001",
    "status": "acked",
    "acked_by": "librarian-001"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 ALERT_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/alerts/:id/resolve`

- **Role:** manage
- **Request:**

```json
{ "note": "Resolved after checking the gate event." }
```
- **Response:**

```json
{
  "data": {
    "id": "alert-001",
    "status": "resolved",
    "resolved_at": "2026-10-10T10:00:00.000Z"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 ALERT_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/alerts/bulk-ack`

- **Role:** manage
- **Request:**

```json
{
  "ids": ["alert-001", "alert-002"],
  "note": "Acknowledged from wallboard triage."
}
```

- **Response:**

```json
{
  "data": [
    {
      "id": "alert-001",
      "status": "acked",
      "acked_by": "librarian-001"
    },
    {
      "id": "alert-002",
      "status": "acked",
      "acked_by": "librarian-001"
    }
  ]
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 ALERT_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/alerts/:id/notes`

- **Role:** manage
- **Request:**

```json
{ "note": "Smoke reading confirmed by camera review." }
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "alert_id": "alert-001",
    "actor_id": "librarian-001",
    "note": "Smoke reading confirmed by camera review.",
    "created_at": "2026-10-10T10:02:00.000Z"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `404 ALERT_NOT_FOUND`, `500 INTERNAL_ERROR`
- **Status:** implemented

Alert rules are loaded from the `rules` table. `alert_thresholds.smoke_ppm.max`
creates a critical `smoke` alert when exceeded; temperature and humidity
thresholds create warning `threshold` alerts when out of band;
`heartbeat_missed_intervals` defaults to `3` and creates `device_offline` when
that many heartbeats are missed; unauthorized gate events or `RFID-UNKNOWN*`
tags create `theft` alerts linked to the nearest camera clip. Repeated open
alerts for the same branch, device, and type are de-duplicated for
`alert_dedup_seconds` or 60 seconds by default.

### `GET /api/telemetry`

- **Role:** manage
- **Request:** `GET /api/telemetry?branchId=branch-east&metric=temperature&from=2026-10-01T00:00:00.000Z&to=2026-10-10T00:00:00.000Z`
- **Response:**

```json
{
  "data": [
    {
      "id": "tel-EAST-1-temperature",
      "device_id": "device-east-5",
      "branch_id": "branch-east",
      "metric": "temperature",
      "value": 23.4,
      "quality": "ok",
      "ts": "2026-10-10T09:00:00.000Z"
    }
  ]
}
```

- **Errors:** `400 INVALID_QUERY`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** partial; raw telemetry query only, no daily curves/export/archive route

### `POST /api/telemetry`

- **Role:** manage
- **Request:**

```json
{
  "deviceId": "device-east-5",
  "branchId": "branch-east",
  "metric": "temperature",
  "value": 23.4,
  "ts": "2026-10-10T09:00:00.000Z"
}
```

- **Response:**

```json
{ "data": { "accepted": true, "queued": 1 } }
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/maintenance`

- **Role:** manage
- **Request:** `GET /api/maintenance?branchId=branch-east&limit=20&offset=0`
- **Response:**

```json
{
  "data": [
    {
      "id": "maint-001",
      "branch_id": "branch-east",
      "device_id": "device-east-1",
      "kind": "device_repair",
      "description": "Maintenance work order 1",
      "started_at": "2026-10-09T09:00:00.000Z",
      "finished_at": null,
      "operator_id": "librarian-001",
      "related_alert_id": "alert-001"
    }
  ]
}
```

- **Errors:** `400 INVALID_QUERY`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/maintenance`

- **Role:** manage
- **Request:**

```json
{
  "branch_id": "branch-east",
  "device_id": "device-east-1",
  "kind": "device_repair",
  "description": "Replace RFID reader cable.",
  "started_at": "2026-10-10T10:00:00.000Z",
  "finished_at": null,
  "operator_id": "librarian-001",
  "related_alert_id": "alert-001"
}
```

- **Response:**

```json
{
  "data": {
    "id": "generated-uuid",
    "branch_id": "branch-east",
    "device_id": "device-east-1",
    "kind": "device_repair",
    "description": "Replace RFID reader cable."
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `409 CONFLICT`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/rules`

- **Role:** operate
- **Request:** no body
- **Response:**

```json
{
  "data": [
    {
      "key": "loan_days",
      "value_json": "30",
      "description": "Default reader loan period in days"
    }
  ],
  "lastChanged": null
}
```

- **Errors:** `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `PUT /api/rules/:key`

- **Role:** manage
- **Request:**

```json
{
  "value": 45,
  "description": "Default reader loan period in days"
}
```

- **Response:**

```json
{
  "data": {
    "key": "loan_days",
    "value_json": "45",
    "description": "Default reader loan period in days"
  },
  "lastChanged": {
    "action": "update_rule",
    "entity": "rule",
    "entity_id": "loan_days",
    "actor_name": "系统管理员"
  }
}
```

- **Errors:** `400 INVALID_INPUT`, `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/branches`

- **Role:** operate
- **Request:** no body
- **Response:**

```json
{
  "data": [
    {
      "id": "branch-east",
      "code": "EAST",
      "name_zh": "校园东馆",
      "name_en": "East Campus Library",
      "type": "campus",
      "address": "东校区明德路 18 号",
      "status": "active"
    }
  ]
}
```

- **Errors:** `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/stats/overview`

- **Role:** manage
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "branches": 3,
    "books": 300,
    "readers": 60,
    "devicesOnline": 24,
    "activeLoans": 30,
    "openAlerts": 12
  }
}
```

- **Errors:** `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `GET /api/stream`

- **Role:** manage
- **Request:** `GET /api/stream?branchId=branch-east&topics=telemetry.received,alert.raised`;
  optional `Last-Event-ID` header or `after` query parameter
- **Response:** `text/event-stream`

```text
id: 43
event: alert.raised
data: {"alertId":"alert-001","branchId":"branch-east","type":"smoke","severity":"critical","message":"Smoke threshold exceeded.","status":"open","ts":"2026-10-10T10:00:00.000Z"}
```

Heartbeat comments use `: keepalive 1728554400000`.
- **Errors:** `401`, `403` before the stream opens
- **Status:** implemented

### `GET /api/simulator/status`

- **Role:** manage
- **Request:** no body
- **Response:**

```json
{
  "data": {
    "enabled": true,
    "running": true,
    "queued": 0,
    "scenarios": {}
  }
}
```

- **Errors:** `401`, `403`, `500 INTERNAL_ERROR`
- **Status:** implemented

### `POST /api/simulator`

- **Role:** manage
- **Request:**

```json
{ "enabled": false }
```

- **Response:**

```json
{
  "data": {
    "enabled": false,
    "running": false,
    "queued": 0,
    "scenarios": {}
  }
}
```

- **Errors:** `400 { "code": "INVALID_ENABLED" }`, `401`, `403`
- **Status:** implemented

### `POST /api/simulator/scenario`

- **Role:** manage
- **Request:**

```json
{ "scenario": "smoke_spike", "branchId": "branch-east" }
```

- **Response:**

```json
{
  "data": {
    "scenario": "smoke_spike",
    "branchId": "branch-east",
    "queued": 0
  }
}
```

- **Errors:** `400 { "code": "INVALID_SCENARIO" }`, `400 SCENARIO_FAILED`, `401`, `403`
- **Status:** implemented

## SSE Events

| Event | Payload example |
|---|---|
| `telemetry.received` | `{ "deviceId": "device-east-5", "branchId": "branch-east", "metric": "temperature", "value": 23.4, "quality": "ok", "ts": "2026-10-10T10:00:00.000Z", "source": "simulator", "sampleId": "tel-001" }` |
| `circulation.borrowed` | `{ "loanId": "loan-001", "bookId": "book-0001", "userId": "reader-001", "branchId": "branch-east", "deviceId": "device-east-1", "action": "borrowed", "ts": "2026-10-10T10:00:00.000Z", "dueAt": "2026-11-09T10:00:00.000Z" }` |
| `circulation.returned` | `{ "loanId": "loan-001", "bookId": "book-0001", "userId": "reader-001", "branchId": "branch-east", "deviceId": "device-east-1", "action": "returned", "ts": "2026-10-10T10:00:00.000Z" }` |
| `circulation.renewed` | `{ "loanId": "loan-001", "bookId": "book-0001", "userId": "reader-001", "branchId": "branch-east", "deviceId": "device-east-1", "action": "renewed", "ts": "2026-10-10T10:00:00.000Z", "dueAt": "2026-12-09T10:00:00.000Z", "renewCount": 1 }` |
| `gate.passed` | `{ "gateEventId": "gate-001", "branchId": "branch-east", "deviceId": "device-east-3", "direction": "out", "rfidTags": ["RFID-000001"], "authorized": true, "ts": "2026-10-10T10:00:00.000Z" }` |
| `alert.raised` | `{ "alertId": "alert-001", "branchId": "branch-east", "deviceId": "device-east-7", "type": "smoke", "severity": "critical", "message": "smoke_ppm threshold exceeded: 20", "status": "open", "relatedClipId": null, "relatedLoanId": null, "ts": "2026-10-10T10:00:00.000Z" }` |
| `alert.acked` | `{ "alertId": "alert-001", "branchId": "branch-east", "deviceId": "device-east-7", "type": "smoke", "severity": "critical", "message": "Smoke threshold exceeded.", "status": "acked", "ackedBy": "librarian-001", "ts": "2026-10-10T10:00:00.000Z" }` |
| `alert.resolved` | `{ "alertId": "alert-001", "branchId": "branch-east", "deviceId": "device-east-7", "type": "smoke", "severity": "critical", "message": "Smoke threshold exceeded.", "status": "resolved", "relatedClipId": "clip-001", "relatedLoanId": null, "ts": "2026-10-10T10:03:00.000Z" }` |
| `alert.noted` | `{ "alertId": "alert-001", "branchId": "branch-east", "deviceId": "device-east-7", "type": "smoke", "severity": "critical", "message": "Checked camera clip.", "status": "acked", "actorId": "librarian-001", "ts": "2026-10-10T10:02:00.000Z" }` |
| `device.status_changed` | `{ "deviceId": "device-east-1", "branchId": "branch-east", "name": "East kiosk", "kind": "kiosk", "from": "online", "to": "offline", "reason": "scenario", "ts": "2026-10-10T10:00:00.000Z", "lastSeenAt": null, "missedIntervals": 3 }` |
| `kpi.updated` | `{ "branchId": "branch-east", "stats": { "branches": 3, "books": 300, "readers": 60, "devicesOnline": 24, "devicesTotal": 30, "activeLoans": 30, "openAlerts": 12 }, "ts": "2026-10-10T10:00:00.000Z" }` |

## Simulator Scenarios

The simulator starts unless `SIMULATOR_ENABLED=false`. It uses
`SIMULATOR_INTERVAL_MS` default `5000` and `SIMULATOR_SEED` default `42`.

| Scenario | Behavior |
|---|---|
| `smoke_spike` | Emits high `smoke_ppm` values for the selected branch for 30 seconds; alert rules can raise a critical smoke alert. |
| `device_offline` | Marks one selected-branch device offline and publishes `device.status_changed`. |
| `illegal_exit` | Inserts an unauthorized gate-out event with an unknown RFID tag and publishes `gate.passed`; alert rules can raise a theft alert and attach the nearest camera clip. |
| `sensor_glitch` | Emits `999999` sensor values for 30 seconds; the pipeline marks them dirty. |
| `network_outage` | Suppresses selected-branch device heartbeats for 30 seconds; missed heartbeats can mark devices offline. |
| `overload` | Queues and flushes 500 telemetry samples for the selected branch. |
| `recover` | Restores selected-branch offline devices to online and publishes status changes. |

## Missing Endpoints

| Requirement | Status |
|---|---|
| Excel/history export by branch and time | missing |
| Archive data older than two years | missing |
| Daily telemetry curves API | missing |
| Camera clip retrieval API | missing |
| Gate event query API | missing |
| QR-only reader authentication | missing |
| Reader offline outbox/sync API | missing |
| Mobile mini-program API | missing |
| AI recommendation API | missing |
| Smart lighting/AC linkage API | missing |
