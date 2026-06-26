const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'profit.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
  });
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sales_price REAL NOT NULL DEFAULT 0,
      pickup_price REAL NOT NULL DEFAULT 0,
      rebate REAL NOT NULL DEFAULT 0,
      note TEXT DEFAULT ''
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      deal_price REAL NOT NULL DEFAULT 0,
      point_rate REAL NOT NULL DEFAULT 0,
      commission REAL NOT NULL DEFAULT 0,
      hk_amount REAL NOT NULL DEFAULT 0,
      profit REAL NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const existing = queryAll('SELECT COUNT(*) as cnt FROM products');
  if (existing[0]?.cnt === 0) {
    db.run(`INSERT INTO products (name, sales_price, pickup_price, rebate, note) VALUES
      ('产品A', 100000, 30000, 5000, '默认产品A'),
      ('产品B', 80000, 25000, 3000, '默认产品B'),
      ('产品C', 50000, 15000, 2000, '默认产品C')
    `);
  }
  saveDb();
  return db;
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
  return db.getRowsModified();
}

// ========== 利润公式 ==========
// 提成 = 成交价 × 3%
// 回款 = 采销价 - (成交价 × 点位% - (成交价 - 采销价)) - 后台返利
// 利润 = 回款 - 提货价 - 提成
// 成交价由用户手动输入，其他价格从产品预设读取
function calcProfit(salesPrice, dealPrice, pickupPrice, pointRate, rebate) {
  const commission = dealPrice * 0.03;
  const hk = salesPrice - (dealPrice * (pointRate / 100) - (dealPrice - salesPrice)) - rebate;
  const profit = hk - pickupPrice - commission;
  return { commission: commission, hkAmount: hk, profit: profit };
}

// ========== API 路由 ==========

// 获取所有产品（不返回敏感价格字段）
app.get('/api/products', async (req, res) => {
  try {
    await getDb();
    const products = queryAll('SELECT id, name, note FROM products ORDER BY id');
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 新增产品
app.post('/api/products', async (req, res) => {
  try {
    await getDb();
    const { name, sales_price, pickup_price, rebate, note } = req.body;
    if (!name || sales_price == null || pickup_price == null || rebate == null) {
      return res.status(400).json({ success: false, message: '产品名称、采销价、提货价、后台返利为必填项' });
    }
    const existing = queryOne('SELECT id FROM products WHERE name = ?', [name.trim()]);
    if (existing) {
      return res.status(400).json({ success: false, message: '产品名称已存在' });
    }
    run('INSERT INTO products (name, sales_price, pickup_price, rebate, note) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), parseFloat(sales_price) || 0, parseFloat(pickup_price) || 0, parseFloat(rebate) || 0, note || '']);
    const lastRow = queryOne('SELECT last_insert_rowid() as id');
    res.json({ success: true, data: { id: lastRow?.id, name: name.trim() } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 更新产品
app.put('/api/products/:id', async (req, res) => {
  try {
    await getDb();
    const id = parseInt(req.params.id);
    const { name, sales_price, pickup_price, rebate, note } = req.body;
    const existing = queryOne('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, message: '产品不存在' });
    }
    run(`UPDATE products SET name=?, sales_price=?, pickup_price=?, rebate=?, note=? WHERE id=?`,
      [name?.trim() || existing.name,
       sales_price != null ? parseFloat(sales_price) : existing.sales_price,
       pickup_price != null ? parseFloat(pickup_price) : existing.pickup_price,
       rebate != null ? parseFloat(rebate) : existing.rebate,
       note != null ? note : existing.note, id]);
    res.json({ success: true, message: '产品更新成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 删除产品
app.delete('/api/products/:id', async (req, res) => {
  try {
    await getDb();
    const id = parseInt(req.params.id);
    const existing = queryOne('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, message: '产品不存在' });
    }
    run('DELETE FROM products WHERE id = ?', [id]);
    res.json({ success: true, message: '产品删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- 利润记录 ----------

// 获取所有记录
app.get('/api/records', async (req, res) => {
  try {
    await getDb();
    const records = queryAll('SELECT * FROM records ORDER BY created_at DESC');
    res.json({ success: true, data: records });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取单条记录
app.get('/api/records/:id', async (req, res) => {
  try {
    await getDb();
    const record = queryOne('SELECT * FROM records WHERE id = ?', [parseInt(req.params.id)]);
    if (!record) {
      return res.status(404).json({ success: false, message: '记录不存在' });
    }
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 新增记录
app.post('/api/records', async (req, res) => {
  try {
    await getDb();
    const { product_id, deal_price, point_rate, note } = req.body;

    if (!product_id || point_rate == null || deal_price == null) {
      return res.status(400).json({ success: false, message: '请选择产品、填写成交价和点位' });
    }

    const product = queryOne('SELECT * FROM products WHERE id = ?', [parseInt(product_id)]);
    if (!product) {
      return res.status(400).json({ success: false, message: '产品不存在' });
    }

    const dp = parseFloat(deal_price) || 0;
    const pr = parseFloat(point_rate) || 0;
    const result = calcProfit(product.sales_price, dp, product.pickup_price, pr, product.rebate);

    run(
      `INSERT INTO records (product_id, product_name, deal_price, point_rate, commission, hk_amount, profit, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [product.id, product.name, dp, pr, result.commission, result.hkAmount, result.profit, note || '']
    );

    const lastRow = queryOne('SELECT last_insert_rowid() as id');
    res.json({
      success: true,
      data: {
        id: lastRow?.id,
        product_id: product.id, product_name: product.name,
        deal_price: dp, point_rate: pr, commission: result.commission, hk_amount: result.hkAmount, profit: result.profit,
        note: note || ''
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 更新记录
app.put('/api/records/:id', async (req, res) => {
  try {
    await getDb();
    const recordId = parseInt(req.params.id);
    const { product_id, deal_price, point_rate, note } = req.body;
    const existing = queryOne('SELECT * FROM records WHERE id = ?', [recordId]);
    if (!existing) {
      return res.status(404).json({ success: false, message: '记录不存在' });
    }

    let productName = existing.product_name;
    let pid = existing.product_id;
    let product = null;

    if (product_id != null) {
      product = queryOne('SELECT * FROM products WHERE id = ?', [parseInt(product_id)]);
      if (!product) {
        return res.status(400).json({ success: false, message: '产品不存在' });
      }
      productName = product.name;
      pid = product.id;
    } else {
      product = queryOne('SELECT * FROM products WHERE id = ?', [existing.product_id]);
      if (!product) {
        return res.status(400).json({ success: false, message: '关联产品不存在' });
      }
    }

    const dp = deal_price != null ? parseFloat(deal_price) : existing.deal_price;
    const pr = point_rate != null ? parseFloat(point_rate) : existing.point_rate;
    const result = calcProfit(product.sales_price, dp, product.pickup_price, pr, product.rebate);

    run(
      `UPDATE records SET product_id=?, product_name=?, deal_price=?, point_rate=?, commission=?, hk_amount=?, profit=?, note=? WHERE id=?`,
      [pid, productName, dp, pr, result.commission, result.hkAmount, result.profit,
       note != null ? note : existing.note, recordId]
    );

    res.json({ success: true, message: '更新成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 删除记录
app.delete('/api/records/:id', async (req, res) => {
  try {
    await getDb();
    const id = parseInt(req.params.id);
    const existing = queryOne('SELECT * FROM records WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, message: '记录不存在' });
    }
    run('DELETE FROM records WHERE id = ?', [id]);
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 前端预览计算（不暴露敏感价格）
app.post('/api/calculate', async (req, res) => {
  try {
    await getDb();
    const { product_id, deal_price, point_rate } = req.body;
    const dp = parseFloat(deal_price) || 0;
    const pr = parseFloat(point_rate) || 0;
    let result = { commission: 0, hkAmount: 0, profit: 0 };
    if (product_id) {
      const product = queryOne('SELECT * FROM products WHERE id = ?', [parseInt(product_id)]);
      if (product) {
        result = calcProfit(product.sales_price, dp, product.pickup_price, pr, product.rebate);
      }
    }
    res.json({ success: true, data: { commission: result.commission, hk_amount: result.hkAmount, profit: result.profit } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取汇总统计
app.get('/api/summary', async (req, res) => {
  try {
    await getDb();
    const stats = queryOne(`
      SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(hk_amount), 0) as total_hk,
        COALESCE(SUM(profit), 0) as total_profit,
        COALESCE(AVG(profit), 0) as avg_profit
      FROM records
    `);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ 利润计算器后端运行在 http://localhost:${PORT}`);
});
