# API requests (frontend → backend)

The frontend appends requests here; the backend answers or implements them (see docs/WORKFLOW.md).

## 1. `call_number` on books — open

- **Endpoint:** `GET /api/books`, `GET /api/books/:id` (and the `book` embedded in loans, if any).
- **Reason:** the kiosk borrow flow and admin catalogue show a library call number (索书号, e.g. `TP311.5/S4`) in monospace on catalogue cards. The `books` table has no such column, so the kiosk currently shows the ISBN labelled "ISBN" instead.
- **Shape:** add a string field to each book:

```json
{ "id": "book-0001", "title": "软件体系结构", "isbn": "9787111…", "call_number": "TP311.5/S4", "category": "TP311", "shelf_location": "A-3-2" }
```

The frontend already reads `call_number` when present (`web/src/kiosk/kioskState.ts`, optional field), so no frontend change is needed once it ships.
