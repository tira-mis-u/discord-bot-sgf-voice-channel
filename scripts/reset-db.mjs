import fs from 'node:fs';
import path from 'node:path';

const dbFile = process.env.DB_FILE || './data/sgf.sqlite';
const absolute = path.resolve(dbFile);
for (const file of [absolute, `${absolute}-wal`, `${absolute}-shm`]) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
console.log(`Removed ${absolute}`);
