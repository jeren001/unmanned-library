import { createServer } from "./api/server.js";

const port = Number(process.env.SERVER_PORT ?? 3001);
const app = createServer();

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
