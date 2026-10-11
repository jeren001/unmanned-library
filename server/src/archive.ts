import { createDomainServices } from "./domain/services.js";
import { createPersistence } from "./persistence/index.js";

const { db, repo } = createPersistence();
const services = createDomainServices(repo);
const result = services.telemetry.archive();
services.audit.log(null, "archive_telemetry", "telemetry", result.cutoff, result);
db.close();
console.log(`Archived ${result.moved} telemetry rows older than ${result.cutoff}`);
