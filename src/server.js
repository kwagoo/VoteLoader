import dotenv from 'dotenv';
import { createApp, readConfig } from './app.js';

dotenv.config();

const config = readConfig();
if (!config.cookieSecret) {
  console.error('COOKIE_SECRET is missing. Copy .env.example to .env and set a long random string.');
  process.exit(1);
}

const app = createApp(config);
const port = Number.isInteger(config.port) && config.port > 0 ? config.port : 3000;

app.listen(port, () => {
  console.log(`VoteLoader listening on http://localhost:${port}`);
});
