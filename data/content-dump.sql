-- ============================================================
--  内容快照（由 scripts/content-sync.mjs 自动生成，请勿手工编辑）
--  内容源是 data/content.db；本文件用于 git diff 审阅 / 备份。
--  恢复缺失数据库：pnpm content:migrate（已有数据库不会被覆盖）
-- ============================================================
PRAGMA foreign_keys = ON;
BEGIN;
DELETE FROM items; DELETE FROM stacks; DELETE FROM groups; DELETE FROM settings;
INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (2, 'voice', 'Optimism_lyrics', '励志类台词(但是从哪里切出来的你别管)', 1, 0);
INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (3, 'voice', 'misc_lyrics', '抽象台/歌词', 2, 0);
INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (4, 'voice', 'noise', '怪叫', 3, 0);
INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (5, 'voice', 'cats_lyrics', '如果你变成了老大的猫猫...?', 4, 0);
INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (6, 'voice', 'forgotten', '往日', 5, 1);
INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (8, 'song', 'song_folk', '民谣', 1, 0);
INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (9, 'song', 'song_rock', '摇滚', 2, 0);
INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (10, 'song', 'song_pop', '流行', 3, 0);
INSERT INTO settings (key, value) VALUES ('song_empty_hint', '还没有歌曲哦，等主人有空放进 public/audio/songs 就能听啦');
INSERT INTO settings (key, value) VALUES ('voice_empty_hint', '还没有音效哦，等主人有空放进 public/audio 就能用啦');
DELETE FROM sqlite_sequence WHERE name IN ('groups', 'stacks', 'items');
INSERT INTO sqlite_sequence (name, seq) VALUES ('groups', 23);
INSERT INTO sqlite_sequence (name, seq) VALUES ('items', 121);
INSERT INTO sqlite_sequence (name, seq) VALUES ('stacks', 15);
COMMIT;
