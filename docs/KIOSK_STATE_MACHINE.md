# Kiosk State Machine

The reader kiosk uses a hand-written reducer in `web/src/kiosk/kioskState.ts`.
The reducer is the State pattern boundary: screens do not mutate workflow state
directly, and every transition is represented by a named action.

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Identify: SHOW_IDENTIFY / card or QR scan
  Identify --> Home: LOGIN
  Identify --> Identify: ERROR
  Home --> Borrow: NAVIGATE(borrow)
  Home --> Return: NAVIGATE(return)
  Home --> Renew: NAVIGATE(renew)
  Home --> Reserve: NAVIGATE(reserve)
  Home --> MyLoans: NAVIGATE(loans)
  Home --> Help: NAVIGATE(help)
  Borrow --> Borrow: ADD_BOOK / SET_BORROW_STEP
  Borrow --> Result: RESULT
  Return --> Return: ADD_BOOK / RESULT
  Renew --> Renew: SET_SELECTED_LOANS
  Renew --> Result: RESULT
  Reserve --> Reserve: SET_BOOKS
  Reserve --> Result: RESULT
  MyLoans --> Home: NAVIGATE(home)
  Help --> Result: RESULT
  Result --> Home: NAVIGATE(home)
  Result --> Idle: LOGOUT
  Identify --> Idle: LOGOUT
  Home --> Idle: LOGOUT
```

The inactivity guard in `web/src/kiosk/KioskPage.tsx` dispatches `LOGOUT`
after a warning countdown. It clears the reducer's user, books, loans, and
result state; the API session is also logged out.
