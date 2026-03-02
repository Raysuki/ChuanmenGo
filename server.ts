import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { RiskLevel } from "./src/types.ts";
import { addDays, isBefore, parseISO, differenceInDays } from "date-fns";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("chuanmenbao.db");

// 初始化数据库
db.exec(`
  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    riskLevel TEXT,
    riskReason TEXT,
    notes TEXT,
    skills TEXT,
    lastVisitedAt TEXT,
    members TEXT
  );

  CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    householdId TEXT,
    visitorName TEXT,
    visitedAt TEXT,
    content TEXT,
    status TEXT,
    image TEXT,
    FOREIGN KEY(householdId) REFERENCES households(id)
  );

  CREATE TABLE IF NOT EXISTS credits (
    id TEXT PRIMARY KEY,
    householdId TEXT,
    type TEXT,
    category TEXT,
    points INTEGER,
    description TEXT,
    evidenceImage TEXT,
    recorderName TEXT,
    createdAt TEXT,
    FOREIGN KEY(householdId) REFERENCES households(id)
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    content TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES ('last_export_at', '1970-01-01T00:00:00.000Z');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('village_name', '科右前旗-红峰村');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('user_name', '李姐');
`);

// 数据库迁移
try {
  db.exec("ALTER TABLE visits ADD COLUMN image TEXT");
} catch (e: any) {
  if (!e.message.includes("duplicate column name")) {
    console.error("Migration error (visits):", e);
  }
}

try {
  db.exec("ALTER TABLE credits ADD COLUMN recorderName TEXT");
} catch (e: any) {
  if (!e.message.includes("duplicate column name")) {
    console.error("Migration error (credits):", e);
  }
}

// 插入初始演示数据
const checkData = db.prepare("SELECT COUNT(*) as count FROM households").get() as any;
if (checkData.count === 0) {
  // No initial data as per user request for "empty on install"
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Helper to format household from DB
  const formatHousehold = (h: any) => ({
    ...h,
    skills: h.skills ? h.skills.split(",") : []
  });

  // API 路由
  app.get("/api/households", (req, res) => {
    const households = db.prepare("SELECT * FROM households").all();
    res.json(households.map(formatHousehold));
  });

  app.post("/api/households/import", (req, res) => {
    const households = req.body;
    if (!Array.isArray(households)) return res.status(400).json({ error: "Invalid data" });

    db.transaction(() => {
      db.prepare("DELETE FROM households").run();
      const stmt = db.prepare(`
        INSERT INTO households (id, name, phone, address, riskLevel, riskReason, notes, skills, members, lastVisitedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const h of households) {
        stmt.run(
          h.id || Math.random().toString(36).substr(2, 9),
          h.name,
          h.phone || "",
          h.address || "",
          h.riskLevel || RiskLevel.GREEN,
          h.riskReason || "",
          h.notes || "",
          Array.isArray(h.skills) ? h.skills.join(",") : (h.skills || ""),
          h.members || "",
          h.lastVisitedAt || null
        );
      }
    })();
    res.json({ success: true });
  });

  app.post("/api/households", (req, res) => {
    const { id, name, phone, address, riskLevel, riskReason, notes, skills, members } = req.body;
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO households (id, name, phone, address, riskLevel, riskReason, notes, skills, members)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, name, phone, address, riskLevel, riskReason, notes, skills.join(","), members);
    res.json({ success: true });
  });

  app.get("/api/settings", (req, res) => {
    const settings = db.prepare("SELECT * FROM settings").all() as any[];
    const result = settings.reduce((acc, curr) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});
    res.json(result);
  });

  app.post("/api/settings", (req, res) => {
    const { key, value } = req.body;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    res.json({ success: true });
  });

  app.get("/api/todo", (req, res) => {
    const households = db.prepare("SELECT * FROM households WHERE riskLevel != 'GREEN'").all();
    const today = new Date();
    
    const todo = households
      .map(formatHousehold)
      .filter((h: any) => {
        if (!h.lastVisitedAt) return true;
        const lastVisit = parseISO(h.lastVisitedAt);
        const daysSinceLastVisit = differenceInDays(today, lastVisit);
        
        // 逻辑：如果距离上次走访天数 >= 规定频率，则出现在待办中
        // 红码：14天/次
        // 黄码：30天/次
        if (h.riskLevel === RiskLevel.RED) {
          return daysSinceLastVisit >= 14;
        }
        if (h.riskLevel === RiskLevel.YELLOW) {
          return daysSinceLastVisit >= 30;
        }
        return false;
      });

    res.json(todo);
  });

  app.post("/api/visits", (req, res) => {
    const { id, householdId, visitedAt, content, status, image } = req.body;
    const userNameSetting = db.prepare("SELECT value FROM settings WHERE key = 'user_name'").get() as any;
    const visitorName = userNameSetting ? userNameSetting.value : "管理员";
    
    const visitStmt = db.prepare(`
      INSERT INTO visits (id, householdId, visitorName, visitedAt, content, status, image)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    visitStmt.run(id, householdId, visitorName, visitedAt, content, status, image);

    const updateStmt = db.prepare("UPDATE households SET lastVisitedAt = ? WHERE id = ?");
    updateStmt.run(visitedAt, householdId);

    res.json({ success: true });
  });

  app.get("/api/visits", (req, res) => {
    const lastExport = db.prepare("SELECT value FROM settings WHERE key = 'last_export_at'").get() as any;
    const visits = db.prepare(`
      SELECT v.*, h.name as householdName 
      FROM visits v
      JOIN households h ON v.householdId = h.id
      WHERE v.visitedAt > ?
      ORDER BY v.visitedAt DESC
    `).all(lastExport.value);
    res.json(visits);
  });

  app.post("/api/export/confirm", (req, res) => {
    const now = new Date().toISOString();
    db.prepare("UPDATE settings SET value = ? WHERE key = 'last_export_at'").run(now);
    res.json({ success: true });
  });

  app.get("/api/credits/summary", (req, res) => {
    const summary = db.prepare(`
      SELECT h.name, SUM(CASE WHEN c.type = 'EARN' THEN c.points ELSE -c.points END) as totalPoints
      FROM households h
      LEFT JOIN credits c ON h.id = c.householdId
      GROUP BY h.id
      ORDER BY totalPoints DESC
    `).all();
    res.json(summary);
  });

  app.get("/api/credits/history", (req, res) => {
    const history = db.prepare(`
      SELECT c.*, h.name as householdName 
      FROM credits c 
      JOIN households h ON c.householdId = h.id 
      ORDER BY c.createdAt DESC 
      LIMIT 50
    `).all();
    res.json(history);
  });

  app.post("/api/credits", (req, res) => {
    const { id, householdId, type, category, points, description, evidenceImage, createdAt } = req.body;
    const userNameSetting = db.prepare("SELECT value FROM settings WHERE key = 'user_name'").get() as any;
    const recorderName = userNameSetting ? userNameSetting.value : "管理员";
    
    const stmt = db.prepare(`
      INSERT INTO credits (id, householdId, type, category, points, description, evidenceImage, recorderName, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, householdId, type, category, points, description, evidenceImage, recorderName, createdAt);
    res.json({ success: true });
  });

  app.get("/api/notes", (req, res) => {
    const notes = db.prepare("SELECT * FROM notes ORDER BY createdAt DESC").all();
    res.json(notes);
  });

  app.post("/api/notes", (req, res) => {
    const { id, content, createdAt } = req.body;
    const stmt = db.prepare("INSERT INTO notes (id, content, createdAt) VALUES (?, ?, ?)");
    stmt.run(id, content, createdAt);
    res.json({ success: true });
  });

  app.put("/api/notes/:id", (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    const now = new Date().toISOString();
    db.prepare("UPDATE notes SET content = ?, createdAt = ? WHERE id = ?").run(content, now, id);
    res.json({ success: true });
  });

  app.delete("/api/notes/:id", (req, res) => {
    try {
      const { id } = req.params;
      console.log('Server: Attempting to delete note with id:', id);
      const result = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      console.log('Server: Delete result:', {
        id,
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid
      });
      res.json({ success: true, changes: result.changes });
    } catch (error) {
      console.error('Server: Delete error:', error);
      res.status(500).json({ error: 'Failed to delete note' });
    }
  });

  // Vite 开发服务器配置
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
