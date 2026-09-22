#!/usr/bin/env node
// Provision a gateway account (scrypt-hashed, stored in ./data/users.json).
// Usage: node server/add-user.js <username> <password-min-8-chars>
// Note: the password appears in shell history — rotate afterwards if shared.
import { addFileUser } from './store.js';

const [, , username, password] = process.argv;
if (!username || !password || password.length < 8) {
  console.error('usage: node server/add-user.js <username> <password-min-8-chars>');
  process.exit(1);
}
try {
  addFileUser(username, password);
  console.log(`user '${username}' saved. Restart the gateway if it is running.`);
} catch (err) {
  console.error('failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
