const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 5500;

const dbConfig = {
  host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
  user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '123456',
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'family_tree',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
};

let pool;
let dbReady = false;

async function getPool() {
  if (!pool) {
    const initPool = mysql.createPool({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      charset: 'utf8mb4'
    });
    try {
      await initPool.execute(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch (e) {
      console.warn('创建数据库警告:', e.message);
    }
    await initPool.end();

    pool = mysql.createPool(dbConfig);
    const createSQL = [
      `CREATE TABLE IF NOT EXISTS families (
        id INT AUTO_INCREMENT PRIMARY KEY,
        surname VARCHAR(20) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        family_id INT NOT NULL,
        contact VARCHAR(50) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_admin TINYINT(1) DEFAULT 0,
        nickname VARCHAR(50) DEFAULT NULL,
        avatar LONGTEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
        UNIQUE KEY uk_family_contact (family_id, contact)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS family_tree (
        id INT AUTO_INCREMENT PRIMARY KEY,
        family_id INT NOT NULL UNIQUE,
        tree_data JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS pending_changes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        family_id INT NOT NULL,
        change_data JSON NOT NULL,
        status ENUM('pending','approved','rejected','cancelled') DEFAULT 'pending',
        submitted_by VARCHAR(50) NOT NULL,
        reviewed_by VARCHAR(50) DEFAULT NULL,
        review_reason TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS operation_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        family_id INT NOT NULL,
        log_data JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS timeline_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        family_id INT NOT NULL,
        event_data JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ];
    for (const sql of createSQL) {
      try { await pool.execute(sql); } catch (e) { console.warn('建表警告:', e.message); }
    }
    const alterSQL = [
      `ALTER TABLE users ADD COLUMN nickname VARCHAR(50) DEFAULT NULL AFTER is_admin`,
      `ALTER TABLE users ADD COLUMN avatar LONGTEXT DEFAULT NULL AFTER nickname`
    ];
    for (const sql of alterSQL) {
      try { await pool.execute(sql); } catch (e) { /* 列已存在则忽略 */ }
    }
    dbReady = true;
    console.log('MySQL 数据库连接成功');
  }
  return pool;
}

async function waitForDB(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const p = await getPool();
      await p.execute('SELECT 1');
      return true;
    } catch (e) {
      console.log(`数据库连接重试 ${i + 1}/${retries}: ${e.message}`);
      pool = null;
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

const sessions = new Map();
const TOKEN_EXPIRE = 24 * 60 * 60 * 1000;

function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: '登录已过期' });
  if (Date.now() - session.ts > TOKEN_EXPIRE) { sessions.delete(token); return res.status(401).json({ error: '登录已过期' }); }
  session.ts = Date.now();
  req.user = session;
  next();
}

async function getFamilyId(surname) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT id FROM families WHERE surname = ?', [surname]);
  return rows.length ? rows[0].id : null;
}

async function ensureFamily(surname) {
  const p = await getPool();
  let fid = await getFamilyId(surname);
  if (!fid) {
    const [r] = await p.execute('INSERT INTO families (surname) VALUES (?)', [surname]);
    fid = r.insertId;
  }
  return fid;
}

async function handleRegister(req, res) {
  try {
    const { surname, contact, password } = req.body;
    if (!surname || !contact || !password) return res.status(400).json({ error: '请填写完整信息' });
    const p = await getPool();
    const fid = await ensureFamily(surname);
    const [ex] = await p.execute('SELECT id FROM users WHERE family_id = ? AND contact = ?', [fid, contact]);
    if (ex.length) return res.status(400).json({ error: '该账号已存在' });
    const [existingUsers] = await p.execute('SELECT COUNT(*) as cnt FROM users WHERE family_id = ?', [fid]);
    const isAdmin = existingUsers[0].cnt === 0 ? 1 : 0;
    const hash = await bcrypt.hash(password, 10);
    await p.execute('INSERT INTO users (family_id, contact, password_hash, is_admin) VALUES (?, ?, ?, ?)',
      [fid, contact, hash, isAdmin]);
    const token = generateToken();
    sessions.set(token, { familyId: fid, surname, contact, isAdmin: !!isAdmin, ts: Date.now() });
    res.json({ token, user: { surname, contact, isAdmin: !!isAdmin } });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

app.post('/api/auth/register', handleRegister);
app.post('/api/register', handleRegister);

async function handleLogin(req, res) {
  try {
    const { surname, contact, password } = req.body;
    if (!surname || !contact || !password) return res.status(400).json({ error: '请填写完整信息' });
    const p = await getPool();
    const fid = await getFamilyId(surname);
    if (!fid) return res.status(400).json({ error: '族谱不存在，请先注册' });
    const [rows] = await p.execute('SELECT * FROM users WHERE family_id = ? AND contact = ?', [fid, contact]);
    if (!rows.length) return res.status(400).json({ error: '账号不存在' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(400).json({ error: '密码错误' });
    const token = generateToken();
    const isAdmin = !!rows[0].is_admin;
    sessions.set(token, { familyId: fid, surname, contact, isAdmin, ts: Date.now() });

    const [treeRows] = await p.execute('SELECT tree_data FROM family_tree WHERE family_id = ?', [fid]);
    const tree = treeRows.length ? treeRows[0].tree_data : null;

    const [pendingRows] = await p.execute('SELECT * FROM pending_changes WHERE family_id = ? ORDER BY created_at DESC', [fid]);
    const pending = pendingRows.map(r => {
      const cd = typeof r.change_data === 'string' ? JSON.parse(r.change_data) : r.change_data;
      return { ...cd, _dbId: r.id, status: r.status, submittedBy: r.submitted_by, reviewedBy: r.reviewed_by, reviewReason: r.review_reason, createdAt: r.created_at, updatedAt: r.updated_at };
    });

    const [logRows] = await p.execute('SELECT * FROM operation_logs WHERE family_id = ? ORDER BY created_at DESC LIMIT 500', [fid]);
    const logs = logRows.map(r => {
      const ld = typeof r.log_data === 'string' ? JSON.parse(r.log_data) : r.log_data;
      return { ...ld, _dbId: r.id, createdAt: r.created_at };
    });

    const [eventRows] = await p.execute('SELECT * FROM timeline_events WHERE family_id = ? ORDER BY created_at DESC', [fid]);
    const timeline = eventRows.map(r => {
      const ed = typeof r.event_data === 'string' ? JSON.parse(r.event_data) : r.event_data;
      return { ...ed, _dbId: r.id, createdAt: r.created_at };
    });

    res.json({ token, user: { surname, contact, isAdmin, nickname: rows[0].nickname || '', avatar: rows[0].avatar || '' }, tree, pending, logs, timeline });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

app.post('/api/auth/login', handleLogin);
app.post('/api/login', handleLogin);

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  sessions.delete(token);
  res.json({ ok: true });
});

app.post('/api/change-password', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写完整信息' });
    const p = await getPool();
    const [rows] = await p.execute('SELECT password_hash FROM users WHERE family_id = ? AND contact = ?', [req.user.familyId, req.user.contact]);
    if (!rows.length) return res.status(400).json({ error: '用户不存在' });
    const valid = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!valid) return res.status(400).json({ error: '当前密码错误' });
    const hash = await bcrypt.hash(newPassword, 10);
    await p.execute('UPDATE users SET password_hash = ? WHERE family_id = ? AND contact = ?', [hash, req.user.familyId, req.user.contact]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    const [rows] = await p.execute('SELECT nickname, avatar FROM users WHERE family_id = ? AND contact = ?', [req.user.familyId, req.user.contact]);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    res.json({ nickname: rows[0].nickname || '', avatar: rows[0].avatar || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const { nickname, avatar } = req.body;
    const p = await getPool();
    const updates = [];
    const vals = [];
    if (nickname !== undefined) { updates.push('nickname = ?'); vals.push(nickname || null); }
    if (avatar !== undefined) { updates.push('avatar = ?'); vals.push(avatar || null); }
    if (updates.length) {
      vals.push(req.user.familyId, req.user.contact);
      await p.execute(`UPDATE users SET ${updates.join(', ')} WHERE family_id = ? AND contact = ?`, vals);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tree', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    const [rows] = await p.execute('SELECT tree_data FROM family_tree WHERE family_id = ?', [req.user.familyId]);
    res.json({ tree: rows.length ? rows[0].tree_data : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tree', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    await p.execute(
      'INSERT INTO family_tree (family_id, tree_data) VALUES (?, ?) ON DUPLICATE KEY UPDATE tree_data = VALUES(tree_data)',
      [req.user.familyId, JSON.stringify(req.body.tree)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pending', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    let sql, params;
    if (req.user.isAdmin) {
      sql = 'SELECT * FROM pending_changes WHERE family_id = ? ORDER BY created_at DESC';
      params = [req.user.familyId];
    } else {
      sql = 'SELECT * FROM pending_changes WHERE family_id = ? AND submitted_by = ? ORDER BY created_at DESC';
      params = [req.user.familyId, req.user.contact];
    }
    const [rows] = await p.execute(sql, params);
    const changes = rows.map(r => {
      const cd = typeof r.change_data === 'string' ? JSON.parse(r.change_data) : r.change_data;
      return { ...cd, _dbId: r.id, status: r.status, submittedBy: r.submitted_by, reviewedBy: r.reviewed_by, reviewReason: r.review_reason, createdAt: r.created_at, updatedAt: r.updated_at };
    });
    res.json({ pending: changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/pending', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    const incoming = Array.isArray(req.body.pending) ? req.body.pending : [];
    const [existing] = await p.execute('SELECT id FROM pending_changes WHERE family_id = ?', [req.user.familyId]);
    const existingIds = new Set(existing.map(r => r.id));
    for (const ch of incoming) {
      const dbId = ch._dbId;
      const clean = { ...ch };
      delete clean._dbId; delete clean.createdAt; delete clean.updatedAt;
      if (dbId && existingIds.has(dbId)) {
        await p.execute('UPDATE pending_changes SET change_data = ?, status = ?, submitted_by = ?, reviewed_by = ?, review_reason = ? WHERE id = ?',
          [JSON.stringify(clean), ch.status || 'pending', ch.submittedBy || req.user.contact, ch.reviewedBy || null, ch.reviewReason || null, dbId]);
        existingIds.delete(dbId);
      } else {
        await p.execute('INSERT INTO pending_changes (family_id, change_data, status, submitted_by, reviewed_by, review_reason) VALUES (?, ?, ?, ?, ?, ?)',
          [req.user.familyId, JSON.stringify(clean), ch.status || 'pending', ch.submittedBy || req.user.contact, ch.reviewedBy || null, ch.reviewReason || null]);
      }
    }
    for (const leftoverId of existingIds) {
      await p.execute('DELETE FROM pending_changes WHERE id = ?', [leftoverId]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/upsert', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可操作' });
    const { contact, password, isAdmin } = req.body;
    if (!contact) return res.status(400).json({ error: '缺少账号' });
    const p = await getPool();
    const [ex] = await p.execute('SELECT id FROM users WHERE family_id = ? AND contact = ?', [req.user.familyId, contact]);
    const hash = password ? await bcrypt.hash(password, 10) : null;
    if (ex.length) {
      const updates = [];
      const vals = [];
      if (hash) { updates.push('password_hash = ?'); vals.push(hash); }
      if (typeof isAdmin !== 'undefined') { updates.push('is_admin = ?'); vals.push(isAdmin ? 1 : 0); }
      if (updates.length) {
        vals.push(ex[0].id);
        await p.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals);
      }
    } else if (hash) {
      await p.execute('INSERT INTO users (family_id, contact, password_hash, is_admin) VALUES (?, ?, ?, ?)',
        [req.user.familyId, contact, hash, isAdmin ? 1 : 0]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logs', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    const [rows] = await p.execute('SELECT * FROM operation_logs WHERE family_id = ? ORDER BY created_at DESC LIMIT 500', [req.user.familyId]);
    res.json({ logs: rows.map(r => {
      const ld = typeof r.log_data === 'string' ? JSON.parse(r.log_data) : r.log_data;
      return { ...ld, _dbId: r.id, createdAt: r.created_at };
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logs', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    const [result] = await p.execute('INSERT INTO operation_logs (family_id, log_data) VALUES (?, ?)', [req.user.familyId, JSON.stringify(req.body)]);
    res.json({ ok: true, id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/logs/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可删除' });
    const p = await getPool();
    await p.execute('DELETE FROM operation_logs WHERE id = ? AND family_id = ?', [req.params.id, req.user.familyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    const [rows] = await p.execute('SELECT * FROM timeline_events WHERE family_id = ? ORDER BY created_at DESC', [req.user.familyId]);
    res.json({ events: rows.map(r => {
      const ed = typeof r.event_data === 'string' ? JSON.parse(r.event_data) : r.event_data;
      return { ...ed, _dbId: r.id, createdAt: r.created_at };
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events', authMiddleware, async (req, res) => {
  try {
    const p = await getPool();
    const ed = { ...req.body, submittedBy: req.user.contact };
    if (!req.user.isAdmin) { ed.status = 'pending'; ed.isPending = true; }
    await p.execute('INSERT INTO timeline_events (family_id, event_data) VALUES (?, ?)', [req.user.familyId, JSON.stringify(ed)]);
    res.json({ ok: true, needsReview: !req.user.isAdmin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/events', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可同步' });
    const p = await getPool();
    await p.execute('DELETE FROM timeline_events WHERE family_id = ?', [req.user.familyId]);
    const events = Array.isArray(req.body.events) ? req.body.events : [];
    for (const ev of events) {
      await p.execute('INSERT INTO timeline_events (family_id, event_data) VALUES (?, ?)', [req.user.familyId, JSON.stringify(ev)]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/events/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可删除' });
    const p = await getPool();
    await p.execute('DELETE FROM timeline_events WHERE id = ? AND family_id = ?', [req.params.id, req.user.familyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reset-family', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可重置' });
    const p = await getPool();
    await p.execute('DELETE FROM family_tree WHERE family_id = ?', [req.user.familyId]);
    await p.execute('DELETE FROM pending_changes WHERE family_id = ?', [req.user.familyId]);
    await p.execute('DELETE FROM operation_logs WHERE family_id = ?', [req.user.familyId]);
    await p.execute('DELETE FROM timeline_events WHERE family_id = ?', [req.user.familyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => {
  try { const p = await getPool(); await p.execute('SELECT 1'); res.json({ ok: true, db: 'connected' }); }
  catch (e) { res.status(500).json({ ok: false, db: 'disconnected', error: e.message }); }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '组普.html')); });

async function start() {
  const dbOk = await waitForDB();
  if (!dbOk) {
    console.error('无法连接 MySQL 数据库，请检查配置');
    console.log('将以无数据库模式启动（数据仅存储在内存中）');
  }
  app.listen(PORT, () => { console.log(`电子族谱已部署: http://localhost:${PORT}/`); });
}

start();