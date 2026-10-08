import { createDatabase } from "./database.js";
import { LibraryRepository } from "./repositories.js";

export function createPersistence(filename?: string) {
  const db = createDatabase(filename);
  return { db, repo: new LibraryRepository(db) };
}
