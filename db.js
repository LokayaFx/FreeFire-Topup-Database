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

function parseRateList(text) {
  const items = [];
  let category = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^[-•*]\s*(.+?)\s*(?:⇒|→|=>|>|=|:)\s*([\d,]+(?:\.\d+)?)\s*LKR/i);
    if (m) {
      const rate = Number(m[2].replace(/,/g, ''));
      if (m[1].trim() && !isNaN(rate) && rate > 0) {
        items.push({ product: m[1].trim().toUpperCase(), rate, category });
      }
      continue;
    }
    if (!/LKR/i.test(line)) {
      const c = line.replace(/[^A-Za-z0-9 ]/g, '').trim();
      if (c) category = c;
    }
  }
  return items;
}

function supabaseClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) notConfigured('Supabase', 'Set SUPABASE_URL and SUPABASE_KEY.');
  if (typeof WebSocket === 'undefined') {
    try { global.WebSocket = require('ws'); } catch { /* ws optional on Node 22+ */ }
  }
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
  async getAllOrders() {
    const sb = supabaseClient();
    const { data, error } = await sb.from('orders').select('*').order('created_at', { ascending: false }).limit(1000);
    if (error) throw error;
    return data || [];
  },
  async getOrderById(id) {
    const sb = supabaseClient();
    const { data, error } = await sb.from('orders').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  },
  async deleteOrder(id) {
    const sb = supabaseClient();
    const { error } = await sb.from('orders').delete().eq('id', id);
    if (error) throw error;
  },
  async updateOrder(id, patch) {
    const sb = supabaseClient();
    const { data, error } = await sb.from('orders').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
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
  },
  async setRate(product, rate, category) {
    const sb = supabaseClient();
    const { error } = await sb.from('rates').upsert({ product, rate, category: category || null, updated_at: new Date().toISOString() }, { onConflict: 'product' });
    if (error) throw error;
  },
  async getRate(product) {
    const sb = supabaseClient();
    const { data, error } = await sb.from('rates').select('*').eq('product', product).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },
  async getAllRates() {
    const sb = supabaseClient();
    const { data, error } = await sb.from('rates').select('*').order('product');
    if (error) throw error;
    return data || [];
  },
  async getSetting(key) {
    const sb = supabaseClient();
    const { data, error } = await sb.from('settings').select('*').eq('key', key).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },
  async setSetting(key, value) {
    const sb = supabaseClient();
    const { error } = await sb.from('settings').upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
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
  async getAllOrders() {
    const rows = readJson(this.ordersFile(), []);
    return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  async getOrderById(id) {
    const rows = readJson(this.ordersFile(), []);
    return rows.find((r) => String(r.id) === String(id)) || null;
  },
  async deleteOrder(id) {
    const file = this.ordersFile();
    const rows = readJson(file, []);
    const next = rows.filter((r) => String(r.id) !== String(id));
    if (next.length === rows.length) throw new Error('Order not found');
    writeJson(file, next);
  },
  async updateOrder(id, patch) {
    const file = this.ordersFile();
    const rows = readJson(file, []);
    const row = rows.find((r) => String(r.id) === String(id));
    if (!row) throw new Error('Order not found');
    Object.assign(row, patch);
    writeJson(file, rows);
    return row;
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
  },
  ratesFile() { return path.join(jsonDir(), 'rates.json'); },
  async setRate(product, rate, category) {
    const file = this.ratesFile();
    const rows = readJson(file, []);
    const ex = rows.find((r) => r.product === product);
    if (ex) { ex.rate = rate; ex.category = category || ex.category || null; ex.updated_at = new Date().toISOString(); }
    else rows.push({ product, rate, category: category || null, updated_at: new Date().toISOString() });
    writeJson(file, rows);
  },
  async getRate(product) {
    return readJson(this.ratesFile(), []).find((r) => r.product === product) || null;
  },
  async getAllRates() {
    return readJson(this.ratesFile(), []).sort((a, b) => String(a.product).localeCompare(String(b.product)));
  },
  settingsFile() { return path.join(jsonDir(), 'settings.json'); },
  async getSetting(key) {
    return readJson(this.settingsFile(), {})[key] ?? null;
  },
  async setSetting(key, value) {
    const file = this.settingsFile();
    const obj = readJson(file, {});
    obj[key] = { key, value: String(value), updated_at: new Date().toISOString() };
    writeJson(file, obj);
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
  CREATE TABLE IF NOT EXISTS verified_users (user_id TEXT PRIMARY KEY, verified_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rates (product TEXT PRIMARY KEY, rate REAL NOT NULL, category TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);`);
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
  async getAllOrders() {
    const db = sqliteDb();
    const rows = db.prepare('SELECT * FROM orders ORDER BY datetime(created_at) DESC LIMIT 1000').all();
    db.close();
    return rows;
  },
  async getOrderById(id) {
    const db = sqliteDb();
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    db.close();
    return row || null;
  },
  async deleteOrder(id) {
    const db = sqliteDb();
    const info = db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    db.close();
    if (!info.changes) throw new Error('Order not found');
  },
  async updateOrder(id, patch) {
    const db = sqliteDb();
    const allowed = ['product', 'player_id', 'price', 'rate', 'created_at'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) { db.close(); throw new Error('Nothing to update'); }
    const info = db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    db.close();
    if (!info.changes) throw new Error('Order not found');
    return row;
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
  },
  async setRate(product, rate, category) {
    const db = sqliteDb();
    db.prepare('INSERT INTO rates (product, rate, category, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(product) DO UPDATE SET rate = excluded.rate, category = excluded.category, updated_at = excluded.updated_at').run(product, rate, category || null, new Date().toISOString());
    db.close();
  },
  async getRate(product) {
    const db = sqliteDb();
    const row = db.prepare('SELECT * FROM rates WHERE product = ?').get(product);
    db.close();
    return row || null;
  },
  async getAllRates() {
    const db = sqliteDb();
    const rows = db.prepare('SELECT * FROM rates ORDER BY product').all();
    db.close();
    return rows;
  },
  async getSetting(key) {
    const db = sqliteDb();
    const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
    db.close();
    return row || null;
  },
  async setSetting(key, value) {
    const db = sqliteDb();
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, String(value), new Date().toISOString());
    db.close();
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
  await pool.execute(`CREATE TABLE IF NOT EXISTS rates (product VARCHAR(64) PRIMARY KEY, rate DECIMAL(12,2) NOT NULL, category VARCHAR(64), updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS settings (\`key\` VARCHAR(64) PRIMARY KEY, value VARCHAR(255) NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
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
  async getAllOrders() {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000');
    await pool.end();
    return rows;
  },
  async getOrderById(id) {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [id]);
    await pool.end();
    return rows[0] || null;
  },
  async deleteOrder(id) {
    const pool = await mysqlPool();
    const [r] = await pool.execute('DELETE FROM orders WHERE id = ?', [id]);
    await pool.end();
    if (!r.affectedRows) throw new Error('Order not found');
  },
  async updateOrder(id, patch) {
    const pool = await mysqlPool();
    const allowed = ['product', 'player_id', 'price', 'rate', 'created_at'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) { await pool.end(); throw new Error('Nothing to update'); }
    const [r] = await pool.execute(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => patch[k]), id]);
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [id]);
    await pool.end();
    if (!r.affectedRows) throw new Error('Order not found');
    return rows[0];
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
  },
  async setRate(product, rate, category) {
    const pool = await mysqlPool();
    await pool.execute('INSERT INTO rates (product, rate, category) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rate = VALUES(rate), category = VALUES(category)', [product, rate, category || null]);
    await pool.end();
  },
  async getRate(product) {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT * FROM rates WHERE product = ?', [product]);
    await pool.end();
    return rows[0] || null;
  },
  async getAllRates() {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT * FROM rates ORDER BY product');
    await pool.end();
    return rows;
  },
  async getSetting(key) {
    const pool = await mysqlPool();
    const [rows] = await pool.execute('SELECT * FROM settings WHERE `key` = ?', [key]);
    await pool.end();
    return rows[0] || null;
  },
  async setSetting(key, value) {
    const pool = await mysqlPool();
    await pool.execute('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, String(value)]);
    await pool.end();
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
  await pool.query(`CREATE TABLE IF NOT EXISTS rates (product TEXT PRIMARY KEY, rate NUMERIC NOT NULL, category TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`);
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
  async getAllOrders() {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000');
    await pool.end();
    return rows;
  },
  async getOrderById(id) {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    await pool.end();
    return rows[0] || null;
  },
  async deleteOrder(id) {
    const pool = await pgPool();
    const r = await pool.query('DELETE FROM orders WHERE id = $1', [id]);
    await pool.end();
    if (!r.rowCount) throw new Error('Order not found');
  },
  async updateOrder(id, patch) {
    const pool = await pgPool();
    const allowed = ['product', 'player_id', 'price', 'rate', 'created_at'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) { await pool.end(); throw new Error('Nothing to update'); }
    const { rows } = await pool.query(`UPDATE orders SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`, [...keys.map((k) => patch[k]), id]);
    await pool.end();
    if (!rows[0]) throw new Error('Order not found');
    return rows[0];
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
  },
  async setRate(product, rate, category) {
    const pool = await pgPool();
    await pool.query('INSERT INTO rates (product, rate, category, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (product) DO UPDATE SET rate = EXCLUDED.rate, category = EXCLUDED.category, updated_at = NOW()', [product, rate, category || null]);
    await pool.end();
  },
  async getRate(product) {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT * FROM rates WHERE product = $1', [product]);
    await pool.end();
    return rows[0] || null;
  },
  async getAllRates() {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT * FROM rates ORDER BY product');
    await pool.end();
    return rows;
  },
  async getSetting(key) {
    const pool = await pgPool();
    const { rows } = await pool.query('SELECT * FROM settings WHERE key = $1', [key]);
    await pool.end();
    return rows[0] || null;
  },
  async setSetting(key, value) {
    const pool = await pgPool();
    await pool.query('INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [key, String(value)]);
    await pool.end();
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
  async getAllOrders() {
    const { client, db } = await mongoDb();
    const rows = await db.collection('orders').find({}).sort({ created_at: -1 }).limit(1000).toArray();
    await client.close();
    return rows.map((r) => ({ ...r, id: r._id }));
  },
  async getOrderById(id) {
    const { client, db } = await mongoDb();
    let row = null;
    try {
      const { ObjectId } = require('mongodb');
      row = await db.collection('orders').findOne({ _id: new ObjectId(id) });
    } catch { row = null; }
    await client.close();
    return row ? { ...row, id: row._id } : null;
  },
  async deleteOrder(id) {
    const { client, db } = await mongoDb();
    const { ObjectId } = require('mongodb');
    const r = await db.collection('orders').deleteOne({ _id: new ObjectId(id) });
    await client.close();
    if (!r.deletedCount) throw new Error('Order not found');
  },
  async updateOrder(id, patch) {
    const { client, db } = await mongoDb();
    const { ObjectId } = require('mongodb');
    const allowed = ['product', 'player_id', 'price', 'rate', 'created_at'];
    const set = {};
    for (const k of allowed) if (patch[k] !== undefined) set[k] = patch[k];
    const r = await db.collection('orders').updateOne({ _id: new ObjectId(id) }, { $set: set });
    const row = await db.collection('orders').findOne({ _id: new ObjectId(id) });
    await client.close();
    if (!r.matchedCount) throw new Error('Order not found');
    return { ...row, id: row._id };
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
  },
  async setRate(product, rate, category) {
    const { client, db } = await mongoDb();
    await db.collection('rates').updateOne({ product }, { $set: { product, rate: Number(rate), category: category || null, updated_at: new Date() } }, { upsert: true });
    await client.close();
  },
  async getRate(product) {
    const { client, db } = await mongoDb();
    const row = await db.collection('rates').findOne({ product });
    await client.close();
    return row || null;
  },
  async getAllRates() {
    const { client, db } = await mongoDb();
    const rows = await db.collection('rates').find({}).sort({ product: 1 }).toArray();
    await client.close();
    return rows;
  },
  async getSetting(key) {
    const { client, db } = await mongoDb();
    const row = await db.collection('settings').findOne({ key });
    await client.close();
    return row || null;
  },
  async setSetting(key, value) {
    const { client, db } = await mongoDb();
    await db.collection('settings').updateOne({ key }, { $set: { key, value: String(value), updated_at: new Date() } }, { upsert: true });
    await client.close();
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
  async getAllOrders() {
    const db = firebaseDb();
    const snap = await db.collection('orders').orderBy('created_at', 'desc').limit(1000).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async getOrderById(id) {
    const db = firebaseDb();
    const snap = await db.collection('orders').doc(String(id)).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  },
  async deleteOrder(id) {
    const db = firebaseDb();
    await db.collection('orders').doc(String(id)).delete();
  },
  async updateOrder(id, patch) {
    const db = firebaseDb();
    await db.collection('orders').doc(String(id)).update(patch);
    const snap = await db.collection('orders').doc(String(id)).get();
    return { id: snap.id, ...snap.data() };
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
  },
  async setRate(product, rate, category) {
    const db = firebaseDb();
    await db.collection('rates').doc(product).set({ product, rate: Number(rate), category: category || null, updated_at: new Date().toISOString() }, { merge: true });
  },
  async getRate(product) {
    const db = firebaseDb();
    const snap = await db.collection('rates').doc(product).get();
    return snap.exists ? snap.data() : null;
  },
  async getAllRates() {
    const db = firebaseDb();
    const snap = await db.collection('rates').orderBy('product').get();
    return snap.docs.map((d) => d.data());
  },
  async getSetting(key) {
    const db = firebaseDb();
    const snap = await db.collection('settings').doc(key).get();
    return snap.exists ? snap.data() : null;
  },
  async setSetting(key, value) {
    const db = firebaseDb();
    await db.collection('settings').doc(key).set({ key, value: String(value), updated_at: new Date().toISOString() }, { merge: true });
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
  async getAllOrders() {
    return this.getRecentOrders(1000);
  },
  async getOrderById(id) {
    const rows = await this.getAllOrders();
    return rows.find((r) => String(r.id) === String(id)) || null;
  },
  async deleteOrder() {
    throw new Error('Sheets delete needs manual row delete. Remove the row from the orders sheet.');
  },
  async updateOrder() {
    throw new Error('Sheets update needs manual edit. Edit the row in the orders sheet.');
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
  },
  async setRate(product, rate, category) {
    const { sheets, id } = await sheetsClient();
    await sheets.spreadsheets.values.append({ spreadsheetId: id, range: 'rates!A:D', valueInputOption: 'RAW', requestBody: { values: [[product, rate, category || '', new Date().toISOString()]] } });
  },
  async getRate(product) {
    const rows = await this.getAllRates();
    return rows.find((r) => String(r.product).toUpperCase() === String(product).toUpperCase()) || null;
  },
  async getAllRates() {
    const { sheets, id } = await sheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'rates!A:D' });
    return (res.data.values || []).slice(1).map((r) => ({ product: r[0], rate: r[1], category: r[2], updated_at: r[3] }));
  },
  async getSetting(key) {
    const { sheets, id } = await sheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'settings!A:B' });
    const row = (res.data.values || []).slice(1).find((r) => r[0] === key);
    return row ? { key: row[0], value: row[1] } : null;
  },
  async setSetting(key, value) {
    const { sheets, id } = await sheetsClient();
    await sheets.spreadsheets.values.append({ spreadsheetId: id, range: 'settings!A:B', valueInputOption: 'RAW', requestBody: { values: [[key, String(value)]] } });
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
  parseRateList,
  async setRate(product, rate, category) {
    const p = String(product).trim().toUpperCase();
    await primary().setRate(p, rate, category);
    mirrorWrite('setRate', p, rate, category);
  },
  getRate(product) { return primary().getRate(String(product).trim().toUpperCase()); },
  getAllRates() { return primary().getAllRates(); },
  getSetting(key) { return primary().getSetting(key); },
  async setSetting(key, value) {
    await primary().setSetting(key, value);
    mirrorWrite('setSetting', key, value);
  },
  async addOrder(payload) {
    const row = await primary().addOrder(payload);
    mirrorWrite('addOrder', payload);
    return row;
  },
  getRecentOrders(limit) { return primary().getRecentOrders(limit); },
  getAllOrderPrices() { return primary().getAllOrderPrices(); },
  getAllOrders() { return primary().getAllOrders(); },
  getOrderById(id) { return primary().getOrderById(id); },
  async deleteOrder(id) {
    await primary().deleteOrder(id);
    for (const m of mirrors()) {
      try { if (m.deleteOrder) await m.deleteOrder(id); } catch (e) { console.error('Mirror deleteOrder failed:', e.message); }
    }
  },
  async updateOrder(id, patch) {
    const row = await primary().updateOrder(id, patch);
    for (const m of mirrors()) {
      try { if (m.updateOrder) await m.updateOrder(id, patch); } catch (e) { console.error('Mirror updateOrder failed:', e.message); }
    }
    return row;
  },
  async searchOrdersByPlayer(playerId) {
    const rows = await primary().getAllOrders();
    return rows.filter((r) => String(r.player_id) === String(playerId));
  },
  async getOrdersInRange(startISO, endISO) {
    const rows = await primary().getAllOrders();
    const s = new Date(startISO).getTime();
    const e = new Date(endISO).getTime();
    return rows.filter((r) => {
      const t = new Date(r.created_at).getTime();
      return t >= s && t <= e;
    });
  },
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
