require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROVIDER = (process.env.DB_PROVIDER || 'supabase').toLowerCase();
const MIRRORS = (process.env.DB_MIRROR || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function getProviderName() {
  return PROVIDER;
}

function notConfigured(name, hint) {
  throw new Error(`${name} not configured. ${hint || ''}`.trim());
}

function supabaseClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) notConfigured('Supabase', 'Set SUPABASE_URL and SUPABASE_KEY.');
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

const supabaseProvider = {
  async addOrder({ product, player_id, price, rate, created_at }) {
    const sb = supabaseClient();
    const { data, error } = await sb.from('orders').insert([{ product, player_id, price, rate, created_at }]).select().single();
    if (error) throw error;
    return data;
  },
  async getRecentOrders(limit = 5) {
    const sb = supabaseClient();
    const { data, error } = await sb.from('orders').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  },
  async getAllOrderPrices() {
    const sb = supabaseClient();
    const { data, error } = await sb.from('orders').select('price, rate');
    if (error) throw error;
    return data || [];
  },
  async isVerifiedUser(userId) {
    const sb = supabaseClient();
    const { data } = await sb.from('verified_users').select('user_id').eq('user_id', userId).single();
    return !!data;
  },
  async verifyUser(userId, verifiedBy) {
    const sb = supabaseClient();
    const { error } = await sb.from('verified_users').upsert({ user_id: userId, verified_by: verifiedBy }, { onConflict: 'user_id' });
    if (error) throw error;
  },
  async unverifyUser(userId) {
    const sb = supabaseClient();
    const { error } = await sb.from('verified_users').delete().eq('user_id', userId);
    if (error) throw error;
  },
  async listVerifiedUsers() {
    const sb = supabaseClient();
    const { data, error } = await sb.from('verified_users').select('user_id, verified_by, created_at').order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
};

function jsonDir() {
  return process.env.JSON_DATA_DIR || path.join(__dirname, 'data');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

const jsonProvider = {
  ordersFile() { return path.join(jsonDir(), 'orders.json'); },
  verifiedFile() { return path.join(jsonDir(), 'verified.json'); },
  async addOrder({ product, player_id, price, rate, created_at }) {
    const file = this.ordersFile();
    const rows = readJson(file, []);
    const id = rows.length ? Math.max(...rows.map((r) => Number(r.id) || 0)) + 1 : 1;
    const row = { id, product, player_id, price, rate, created_at: created_at || new Date().toISOString() };
    rows.push(row);
    writeJson(file, rows);
    return row;
  },
  async getRecentOrders(limit = 5) {
    const rows = readJson(this.ordersFile(), []);
    return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
  },
  async getAllOrderPrices() {
    const rows = readJson(this.ordersFile(), []);
    return rows.map((r) => ({ price: r.price, rate: r.rate }));
  },
  async isVerifiedUser(userId) {
    const rows = readJson(this.verifiedFile(), []);
    return rows.some((r) => r.user_id === userId);
  },
  async verifyUser(userId, verifiedBy) {
    const file = this.verifiedFile();
    const rows = readJson(file, []);
    const existing = rows.find((r) => r.user_id === userId);
    if (existing) existing.verified_by = verifiedBy;
    else rows.push({ user_id: userId, verified_by: verifiedBy, created_at: new Date().toISOString() });
    writeJson(file, rows);
  },
  async unverifyUser(userId) {
    const file = this.verifiedFile();
    writeJson(file, readJson(file, []).filter((r) => r.user_id !== userId));
  },
  async listVerifiedUsers() {
    const rows = readJson(this.verifiedFile(), []);
    return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
};

function sqliteDb() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    notConfigured('SQLite driver', 'Run: npm i better-sqlite3');
  }
  const file = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'app.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT NOT NULL, player_id TEXT NOT NULL, price REAL NOT NULL, rate REAL NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS verified_users (user_id TEXT PRIMARY KEY, verified_by TEXT NOT NULL, created_at TEXT NOT NULL);`);
  return db;
}

const sqliteProvider = {
  async addOrder({ product, player_id, price, rate, created_at }) {
    const db = sqliteDb();
    const iso = created_at || new Date().toISOString();
    const info = db.prepare('INSERT INTO orders (product, player_id, price, rate, created_at) VALUES (?, ?, ?, ?, ?)').run(product, player_id, price, rate, iso);
    db.close();
    return { id: info.lastInsertRowid, product, player_id, price, rate, created_at: iso };
  },
  async getRecentOrders(limit = 5) {
    const db = sqliteDb();
    const rows = db.prepare('SELECT * FROM orders ORDER BY datetime(created_at) DESC LIMIT ?').all(limit);
    db.close();
    return rows;
  },
  async getAllOrderPrices() {
    const db = sqliteDb();
    const rows = db.prepare('SELECT price, rate FROM orders').all();
    db.close();
    return rows;
  },
  async isVerifiedUser(userId) {
    const db = sqliteDb();
    const row = db.prepare('SELECT user_id FROM verified_users WHERE user_id = ?').get(userId);
    db.close();
    return !!row;
  },
  async verifyUser(userId, verifiedBy) {
    const db = sqliteDb();
    db.prepare('INSERT INTO verified_users (user_id, verified_by, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET verified_by = excluded.verified_by').run(userId, verifiedBy, new Date().toISOString());
    db.close();
  },
  async unverifyUser(userId) {
    const db = sqliteDb();
    db.prepare('DELETE FROM verified_users WHERE user_id = ?').run(userId);
    db.close();
  },
  async listVerifiedUsers() {
    const db = sqliteDb();
    const rows = db.prepare('SELECT * FROM verified_users ORDER BY datetime(created_at) DESC').all();
    db.close();
    return rows;
  }
};

async function mysqlPool() {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch {
    notConfigured('MySQL driver', 'Run: npm i mysql2');
  }
  if (!process.env.DATABASE_URL && !process.env.MYSQL_URL) notConfigured('MySQL', 'Set DATABASE_URL or MYSQL_URL.');
  const uri = process.env.DATABASE_URL || process.env.MYSQL_URL;
  const pool = mysql.createPool(uri);
  await pool.execute(`CREATE TABLE IF NOT EXISTS orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, product TEXT NOT NULL, player_id TEXT NOT NULL, price DECIMAL(12,2) NOT NULL, rate DECIMAL(12,2) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS verified_users (user_id VARCHAR(64) PRIMARY KEY, verified_by VARCHAR(64) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  return pool;
}

const mysqlProvider = {
  async addOrder({ product, player_id, price, rate, created_at }) {
    const pool = await mysqlPool();
    const [r] = await pool.execute('INSERT INTO orders (product, player_id, price, rate, created_at) VALUES (?, ?, ?, ?, ?)', [product, player_id, price, rate, created_at ? new Date(created_at) : new Date()]);
    await pool.end();
    return { id: r.insertId, product, player_id, price, rate, created_at };
  },
  async getRecentOrders(limit = 5) {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', [String(limit)]);
    await pool.end();
    return rows;
  },
  async getAllOrderPrices() {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT price, rate FROM orders');
    await pool.end();
    return rows;
  },
  async isVerifiedUser(userId) {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT user_id FROM verified_users WHERE user_id = ?', [userId]);
    await pool.end();
    return rows.length > 0;
  },
  async verifyUser(userId, verifiedBy) {
    const pool = await mysqlPool();
    await pool.execute('INSERT INTO verified_users (user_id, verified_by) VALUES (?, ?) ON DUPLICATE KEY UPDATE verified_by = VALUES(verified_by)', [userId, verifiedBy]);
    await pool.end();
  },
  async unverifyUser(userId) {
    const pool = await mysqlPool();
    await pool.execute('DELETE FROM verified_users WHERE user_id = ?', [userId]);
    await pool.end();
  },
  async listVerifiedUsers() {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT * FROM verified_users ORDER BY created_at DESC');
    await pool.end();
    return rows;
  }
};

async function pgPool() {
  let Pg;
  try {
    Pg = require('pg').Pool;
  } catch {
    notConfigured('Postgres driver', 'Run: npm i pg');
  }
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) notConfigured('Postgres', 'Set DATABASE_URL or POSTGRES_URL.');
  const pool = new Pg({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL });
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY, product TEXT NOT NULL, player_id TEXT NOT NULL, price NUMERIC NOT NULL, rate NUMERIC NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS verified_users (user_id TEXT PRIMARY KEY, verified_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  return pool;
}

const postgresProvider = {
  async addOrder({ product, player_id, price, rate, created_at }) {
    const pool = await pgPool();
    const { rows } = await pool.query('INSERT INTO orders (product, player_id, price, rate, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *', [product, player_id, price, rate, created_at || new Date().toISOString()]);
    await pool.end();
    return rows[0];
  },
  async getRecentOrders(limit = 5) {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT $1', [limit]);
    await pool.end();
    return rows;
  },
  async getAllOrderPrices() {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT price, rate FROM orders');
    await pool.end();
    return rows;
  },
  async isVerifiedUser(userId) {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT user_id FROM verified_users WHERE user_id = $1', [userId]);
    await pool.end();
    return rows.length > 0;
  },
  async verifyUser(userId, verifiedBy) {
    const pool = await pgPool();
    await pool.query('INSERT INTO verified_users (user_id, verified_by) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET verified_by = EXCLUDED.verified_by', [userId, verifiedBy]);
    await pool.end();
  },
  async unverifyUser(userId) {
    const pool = await pgPool();
    await pool.query('DELETE FROM verified_users WHERE user_id = $1', [userId]);
    await pool.end();
  },
  async listVerifiedUsers() {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT * FROM verified_users ORDER BY created_at DESC');
    await pool.end();
    return rows;
  }
};

async function mongoDb() {
  let MongoClient;
  try {
    MongoClient = require('mongodb').MongoClient;
  } catch {
    notConfigured('MongoDB driver', 'Run: npm i mongodb');
  }
  if (!process.env.MONGO_URI) notConfigured('MongoDB', 'Set MONGO_URI.');
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  return { client, db: client.db(process.env.MONGO_DB || 'freefire') };
}

const mongoProvider = {
  async addOrder({ product, player_id, price, rate, created_at }) {
    const { client, db } = await mongoDb();
    const doc = { product, player_id, price: Number(price), rate: Number(rate), created_at: created_at ? new Date(created_at) : new Date() };
    const r = await db.collection('orders').insertOne(doc);
    await client.close();
    return { id: r.insertedId, ...doc };
  },
  async getRecentOrders(limit = 5) {
    const { client, db } = await mongoDb();
    const rows = await db.collection('orders').find({}).sort({ created_at: -1 }).limit(limit).toArray();
    await client.close();
    return rows.map((r) => ({ ...r, id: r._id }));
  },
  async getAllOrderPrices() {
    const { client, db } = await mongoDb();
    const rows = await db.collection('orders').find({}, { projection: { price: 1, rate: 1 } }).toArray();
    await client.close();
    return rows;
  },
  async isVerifiedUser(userId) {
    const { client, db } = await mongoDb();
    const row = await db.collection('verified_users').findOne({ user_id: userId });
    await client.close();
    return !!row;
  },
  async verifyUser(userId, verifiedBy) {
    const { client, db } = await mongoDb();
    await db.collection('verified_users').updateOne({ user_id: userId }, { $set: { user_id: userId, verified_by: verifiedBy, created_at: new Date() } }, { upsert: true });
    await client.close();
  },
  async unverifyUser(userId) {
    const { client, db } = await mongoDb();
    await db.collection('verified_users').deleteOne({ user_id: userId });
    await client.close();
  },
  async listVerifiedUsers() {
    const { client, db } = await mongoDb();
    const rows = await db.collection('verified_users').find({}).sort({ created_at: -1 }).toArray();
    await client.close();
    return rows;
  }
};

function firebaseDb() {
  let admin;
  try {
    admin = require('firebase-admin');
  } catch {
    notConfigured('Firebase driver', 'Run: npm i firebase-admin');
  }
  if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      admin.initializeApp({ credential: admin.credential.cert(require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)) });
    } else {
      notConfigured('Firebase', 'Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH.');
    }
  }
  return admin.firestore();
}

const firebaseProvider = {
  async addOrder({ product, player_id, price, rate, created_at }) {
    const db = firebaseDb();
    const ref = await db.collection('orders').add({ product, player_id, price: Number(price), rate: Number(rate), created_at: created_at || new Date().toISOString() });
    const snap = await ref.get();
    return { id: ref.id, ...snap.data() };
  },
  async getRecentOrders(limit = 5) {
    const db = firebaseDb();
    const snap = await db.collection('orders').orderBy('created_at', 'desc').limit(limit).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async getAllOrderPrices() {
    const db = firebaseDb();
    const snap = await db.collection('orders').select('price', 'rate').get();
    return snap.docs.map((d) => d.data());
  },
  async isVerifiedUser(userId) {
    const db = firebaseDb();
    const snap = await db.collection('verified_users').doc(userId).get();
    return snap.exists;
  },
  async verifyUser(userId, verifiedBy) {
    const db = firebaseDb();
    await db.collection('verified_users').doc(userId).set({ user_id: userId, verified_by: verifiedBy, created_at: new Date().toISOString() }, { merge: true });
  },
  async unverifyUser(userId) {
    const db = firebaseDb();
    await db.collection('verified_users').doc(userId).delete();
  },
  async listVerifiedUsers() {
    const db = firebaseDb();
    const snap = await db.collection('verified_users').orderBy('created_at', 'desc').get();
    return snap.docs.map((d) => d.data());
  }
};

async function sheetsClient() {
  let google;
  try {
    google = require('googleapis').google;
  } catch {
    notConfigured('Google Sheets driver', 'Run: npm i googleapis');
  }
  if (!process.env.GOOGLE_SHEETS_ID) notConfigured('Google Sheets', 'Set GOOGLE_SHEETS_ID.');
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_PATH || undefined,
    credentials: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return { sheets: google.sheets({ version: 'v4', auth }), id: process.env.GOOGLE_SHEETS_ID };
}

const sheetsProvider = {
  async addOrder({ product, player_id, price, rate, created_at }) {
    const { sheets, id } = await sheetsClient();
    const iso = created_at || new Date().toISOString();
    await sheets.spreadsheets.values.append({ spreadsheetId: id, range: 'orders!A:F', valueInputOption: 'RAW', requestBody: { values: [[iso, product, player_id, price, rate, Number(price) - Number(rate)]] } });
    return { id: iso, product, player_id, price, rate, created_at: iso };
  },
  async getRecentOrders(limit = 5) {
    const { sheets, id } = await sheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'orders!A:F' });
    const rows = (res.data.values || []).slice(1).map((r, i) => ({ id: i + 1, created_at: r[0], product: r[1], player_id: r[2], price: r[3], rate: r[4] }));
    return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
  },
  async getAllOrderPrices() {
    const { sheets, id } = await sheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'orders!A:F' });
    return (res.data.values || []).slice(1).map((r) => ({ price: r[3], rate: r[4] }));
  },
  async isVerifiedUser(userId) {
    const { sheets, id } = await sheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'verified!A:C' });
    return (res.data.values || []).slice(1).some((r) => r[0] === userId);
  },
  async verifyUser(userId, verifiedBy) {
    const { sheets, id } = await sheetsClient();
    await sheets.spreadsheets.values.append({ spreadsheetId: id, range: 'verified!A:C', valueInputOption: 'RAW', requestBody: { values: [[userId, verifiedBy, new Date().toISOString()]] } });
  },
  async unverifyUser() {
    throw new Error('Sheets unverify needs manual row delete. Remove the user row from the verified sheet.');
  },
  async listVerifiedUsers() {
    const { sheets, id } = await sheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'verified!A:C' });
    return (res.data.values || []).slice(1).map((r) => ({ user_id: r[0], verified_by: r[1], created_at: r[2] }));
  }
};

const PROVIDERS = {
  supabase: supabaseProvider,
  json: jsonProvider,
  sqlite: sqliteProvider,
  mysql: mysqlProvider,
  postgres: postgresProvider,
  pg: postgresProvider,
  mongo: mongoProvider,
  mongodb: mongoProvider,
  firebase: firebaseProvider,
  firestore: firebaseProvider,
  sheets: sheetsProvider,
  googlesheets: sheetsProvider
};

function primary() {
  const p = PROVIDERS[PROVIDER];
  if (!p) throw new Error(`Unknown DB_PROVIDER: ${PROVIDER}`);
  return p;
}

function mirrors() {
  return MIRRORS.map((m) => PROVIDERS[m]).filter(Boolean);
}

async function mirrorWrite(fn, ...args) {
  for (const m of mirrors()) {
    try {
      if (m[fn]) await m[fn](...args);
    } catch (e) {
      console.error(`Mirror ${fn} failed:`, e.message);
    }
  }
}

module.exports = {
  getProviderName,
  async addOrder(payload) {
    const row = await primary().addOrder(payload);
    mirrorWrite('addOrder', payload);
    return row;
  },
  getRecentOrders(limit) { return primary().getRecentOrders(limit); },
  getAllOrderPrices() { return primary().getAllOrderPrices(); },
  isVerifiedUser(userId) { return primary().isVerifiedUser(userId); },
  async verifyUser(userId, verifiedBy) {
    await primary().verifyUser(userId, verifiedBy);
    mirrorWrite('verifyUser', userId, verifiedBy);
  },
  async unverifyUser(userId) {
    await primary().unverifyUser(userId);
    mirrorWrite('unverifyUser', userId);
  },
  listVerifiedUsers() { return primary().listVerifiedUsers(); }
};
