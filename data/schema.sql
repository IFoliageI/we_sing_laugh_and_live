-- ============================================================
--  we_sing_laugh_and_live —— 内容数据库结构
--  用途：作为「渺の怪动静」与「渺の歌单」两个栏目的唯一内容源。
--  构建时由 scripts/content-sync.mjs 读取本库并生成 src/data/content.json，
--  前端代码再从 content.json 读取数据（站点本身仍是纯静态）。
--
--  手工重建数据库：
--      node scripts/content-migrate.mjs      # 从旧的 TS 数据迁移（一次性）
--  或直接用 sqlite3 执行本文件：
--      sqlite3 data/content.db < data/schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- 分组（一个分组 = 页面上的一张卡片，如「悲鸣」「怪叫」「ACG」）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  section     TEXT    NOT NULL CHECK (section IN ('voice', 'song')),
                          -- voice = 首页「渺の怪动静」；song = 歌单页「渺の歌单」
  group_name  TEXT    NOT NULL,        -- 分组 id，用于锚点/URL，如 cry_lyrics
  title       TEXT    NOT NULL,        -- 卡片上显示的标题，如「悲鸣」
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_secret   INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0, 1)),
                          -- 1 = 彩蛋分组：只有打开「往日?」开关后才显示（如 forgotten）
  UNIQUE (section, group_name)
);

-- ------------------------------------------------------------
-- 合集（堆叠按钮：一个按钮对应多条音频）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stacks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title       TEXT,                     -- 合集名；留空则前端显示「合集」
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_example  INTEGER NOT NULL DEFAULT 0 CHECK (is_example IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_stacks_group ON stacks(group_id);

-- ------------------------------------------------------------
-- 音频条目（每个按钮 / 每首歌 / 每条彩蛋音频）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  stack_id    INTEGER REFERENCES stacks(id) ON DELETE CASCADE,
                          -- NULL = 独立按钮；有值 = 属于某个合集的堆叠按钮
  kind        TEXT    NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'hidden')),
                          -- normal = 普通按钮；hidden = 彩蛋「往日」音频（不参与随机、不能直链播放）
  path        TEXT    NOT NULL,        -- 音频路径，相对 public/audio，如 cry_lyrics/示例.mp3
  zh          TEXT    NOT NULL,        -- 按钮上显示的文字
  artist      TEXT,                    -- 原唱作者（歌单页可按它分组；音效类留空）
  info_time   TEXT,                    -- 悬停卡片：时间
  info_title  TEXT,                    -- 悬停卡片：标题
  info_note   TEXT,                    -- 悬停卡片：备注
  info_thumb  TEXT,                    -- 悬停卡片：缩略图（/thumbs/xxx.png 或完整 URL）
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_example  INTEGER NOT NULL DEFAULT 0 CHECK (is_example IN (0, 1)),
                          -- 1 = 占位示例条目，可用 pnpm content:rm-examples 一键清除
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (group_id, path)              -- 同一分组内不允许重复路径（跨分组允许）
);
CREATE INDEX IF NOT EXISTS idx_items_group ON items(group_id);
CREATE INDEX IF NOT EXISTS idx_items_stack ON items(stack_id);

-- ------------------------------------------------------------
-- 全局文案 / 配置
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ------------------------------------------------------------
-- 常用视图：把「按钮 / 合集成员 / 彩蛋」三类一次看清
-- ------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_items AS
SELECT
  i.id,
  g.section,
  g.group_name,
  g.title            AS group_title,
  CASE
    WHEN i.kind = 'hidden' THEN '彩蛋音频'
    WHEN i.stack_id IS NOT NULL THEN '合集成员'
    ELSE '独立按钮'
  END                AS item_type,
  s.title            AS stack_title,
  i.path,
  i.zh,
  i.artist,
  i.info_time,
  i.info_title,
  i.info_note,
  i.info_thumb,
  i.sort_order,
  i.is_example
FROM items i
JOIN groups g ON g.id = i.group_id
LEFT JOIN stacks s ON s.id = i.stack_id;
