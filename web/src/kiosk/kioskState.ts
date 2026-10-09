export type KioskScreen = "idle" | "identify" | "home" | "borrow" | "return" | "renew" | "reserve" | "loans" | "help" | "result";
export type FlowKind = "borrow" | "return" | "renew" | "reserve";
export type BorrowStep = "scan" | "confirm" | "receipt";

export type KioskUser = {
  id: string;
  role: "reader";
  name: string;
  account: string;
};

export type Book = {
  id: string;
  title: string;
  author: string;
  isbn: string;
  rfid_tag: string;
  branch_id: string;
  shelf_location: string;
  cover_color: string;
  category?: string;
  /** Not served by the API yet; requested in docs/API_REQUESTS.md. */
  call_number?: string;
  status: "on_shelf" | "borrowed" | "lost" | "repair";
};

export type Loan = {
  id: string;
  book_id: string;
  user_id: string;
  branch_id: string;
  borrowed_at: string;
  due_at: string;
  returned_at?: string | null;
  renew_count: number;
  status: "active" | "returned" | "overdue" | "lost";
  book?: Book;
};

export type KioskResult = {
  kind: "success" | "offline" | "warning";
  title: string;
  detail: string;
  items?: Array<{ title: string; dueAt?: string; shelf?: string }>;
  queuedCount?: number;
};

export type KioskState = {
  screen: KioskScreen;
  user: KioskUser | null;
  books: Book[];
  scannedBookIds: string[];
  loans: Loan[];
  selectedLoanIds: string[];
  flow: FlowKind | null;
  borrowStep: BorrowStep;
  result: KioskResult | null;
  error: string;
  inputError: string;
  network: "online" | "offline" | "syncing";
  outboxCount: number;
  branchName: string;
  branchId: string;
  occupancy: number;
  capacity: number;
  voiceEnabled: boolean;
  soundEnabled: boolean;
  devOpen: boolean;
};

export const initialKioskState: KioskState = {
  screen: "idle",
  user: null,
  books: [],
  scannedBookIds: [],
  loans: [],
  selectedLoanIds: [],
  flow: null,
  borrowStep: "scan",
  result: null,
  error: "",
  inputError: "",
  network: typeof navigator === "undefined" || navigator.onLine ? "online" : "offline",
  outboxCount: 0,
  branchName: "校园东馆 / East Campus Library",
  branchId: "branch-east",
  occupancy: 7,
  capacity: 40,
  voiceEnabled: true,
  soundEnabled: false,
  devOpen: typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dev") === "1"
};

export type KioskAction =
  | { type: "SHOW_IDENTIFY" }
  | { type: "LOGIN"; user: KioskUser }
  | { type: "LOGOUT" }
  | { type: "NAVIGATE"; screen: Exclude<KioskScreen, "idle" | "identify" | "result"> }
  | { type: "SET_BOOKS"; books: Book[] }
  | { type: "SET_LOANS"; loans: Loan[] }
  | { type: "SET_SELECTED_LOANS"; ids: string[] }
  | { type: "ADD_BOOK"; book: Book }
  | { type: "CLEAR_SCANNED_BOOKS" }
  | { type: "REMOVE_BOOK"; bookId?: string }
  | { type: "SET_BORROW_STEP"; step: BorrowStep }
  | { type: "SET_FLOW"; flow: FlowKind | null }
  | { type: "RESULT"; result: KioskResult }
  | { type: "CLEAR_ERROR" }
  | { type: "ERROR"; message: string }
  | { type: "INPUT_ERROR"; message: string }
  | { type: "SET_NETWORK"; network: KioskState["network"] }
  | { type: "SET_OUTBOX_COUNT"; count: number }
  | { type: "SET_DEV"; open: boolean }
  | { type: "TOGGLE_VOICE" }
  | { type: "TOGGLE_SOUND" };

export function kioskReducer(state: KioskState, action: KioskAction): KioskState {
  switch (action.type) {
    case "SHOW_IDENTIFY":
      return { ...state, screen: "identify", error: "", inputError: "" };
    case "LOGIN":
      return { ...state, user: action.user, screen: "home", error: "", inputError: "", result: null };
    case "LOGOUT":
      return { ...initialKioskState, network: state.network, outboxCount: state.outboxCount, devOpen: state.devOpen };
    case "NAVIGATE":
      return {
        ...state,
        screen: action.screen,
        flow: ["borrow", "return", "renew", "reserve"].includes(action.screen) ? action.screen as FlowKind : null,
        borrowStep: "scan",
        result: null,
        error: "",
        inputError: "",
        selectedLoanIds: [],
        scannedBookIds: action.screen === "borrow" ? [] : state.scannedBookIds
      };
    case "SET_BOOKS":
      return { ...state, books: action.books, inputError: "" };
    case "SET_LOANS":
      return { ...state, loans: action.loans };
    case "SET_SELECTED_LOANS":
      return { ...state, selectedLoanIds: action.ids };
    case "ADD_BOOK":
      return {
        ...state,
        books: state.books.some((book) => book.id === action.book.id) ? state.books : [...state.books, action.book],
        scannedBookIds: state.scannedBookIds.includes(action.book.id) ? state.scannedBookIds : [...state.scannedBookIds, action.book.id],
        inputError: ""
      };
    case "CLEAR_SCANNED_BOOKS":
      return { ...state, scannedBookIds: [] };
    case "REMOVE_BOOK":
      return { ...state, scannedBookIds: action.bookId ? state.scannedBookIds.filter((id) => id !== action.bookId) : state.scannedBookIds.slice(0, -1) };
    case "SET_BORROW_STEP":
      return { ...state, borrowStep: action.step };
    case "SET_FLOW":
      return { ...state, flow: action.flow };
    case "RESULT":
      return { ...state, screen: "result", result: action.result, error: "", inputError: "" };
    case "CLEAR_ERROR":
      return { ...state, error: "", inputError: "" };
    case "ERROR":
      return { ...state, error: action.message };
    case "INPUT_ERROR":
      return { ...state, inputError: action.message };
    case "SET_NETWORK":
      return { ...state, network: action.network };
    case "SET_OUTBOX_COUNT":
      return { ...state, outboxCount: action.count };
    case "SET_DEV":
      return { ...state, devOpen: action.open };
    case "TOGGLE_VOICE":
      return { ...state, voiceEnabled: !state.voiceEnabled };
    case "TOGGLE_SOUND":
      return { ...state, soundEnabled: !state.soundEnabled };
    default:
      return state;
  }
}
