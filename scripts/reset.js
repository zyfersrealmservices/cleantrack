// Deletes the database and uploaded photos so the next "npm start" begins fresh
// with the sample data again. Run with: npm run reset
const fs = require('node:fs');
const path = require('node:path');
const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('Database deleted. Run "npm start" to create a fresh one with sample data.');
