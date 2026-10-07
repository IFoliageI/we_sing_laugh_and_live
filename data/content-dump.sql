-- ============================================================
--  内容快照（由 scripts/content-sync.mjs 自动生成，请勿手工编辑）
--  内容源是 data/content.db；本文件用于 git diff 审阅 / 备份。
--  重建：sqlite3 data/content.db < data/content-dump.sql
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
INSERT INTO stacks (id, group_id, title, sort_order, is_example) VALUES (2, 2, '励志合集', 0, 1);
INSERT INTO stacks (id, group_id, title, sort_order, is_example) VALUES (3, 3, '抽象合集', 0, 1);
INSERT INTO stacks (id, group_id, title, sort_order, is_example) VALUES (4, 4, '怪叫合集', 0, 1);
INSERT INTO stacks (id, group_id, title, sort_order, is_example) VALUES (5, 5, '猫猫合集', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (5, 2, NULL, 'normal', 'Optimism_lyrics/示例.mp3', '示例：励志按钮（改成音效名）', NULL, '2024年3月16日 19:00', '聊聊近况', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (6, 2, 2, 'normal', 'Optimism_lyrics/励志_1.mp3', '励志 · 第一句', NULL, '2024年3月16日 19:05', '聊聊近况 · 片段一', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (7, 2, 2, 'normal', 'Optimism_lyrics/励志_2.mp3', '励志 · 第二句', NULL, '2024年3月16日 19:10', '聊聊近况 · 片段二', NULL, '/thumbs/placeholder.svg', 1, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (9, 3, NULL, 'normal', 'misc_lyrics/示例.mp3', '示例：抽象按钮（改成音效名）', NULL, '2024年3月17日 22:45', '口胡大会', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (10, 3, 3, 'normal', 'misc_lyrics/抽象_1.mp3', '抽象 · 第一段', NULL, '2024年3月17日 22:50', '口胡大会 · 片段一', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (11, 3, 3, 'normal', 'misc_lyrics/抽象_2.mp3', '抽象 · 第二段', NULL, '2024年3月17日 22:55', '口胡大会 · 片段二', NULL, '/thumbs/placeholder.svg', 1, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (13, 4, NULL, 'normal', 'noise/示例.mp3', '示例：怪叫按钮（改成音效名）', NULL, '2024年3月18日 20:10', '突发恶疾', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (14, 4, 4, 'normal', 'noise/怪叫_1.mp3', '怪叫 · 第一声', NULL, '2024年3月18日 20:12', '突发恶疾 · 片段一', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (15, 4, 4, 'normal', 'noise/怪叫_2.mp3', '怪叫 · 第二声', NULL, '2024年3月18日 20:15', '突发恶疾 · 片段二', NULL, '/thumbs/placeholder.svg', 1, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (17, 5, NULL, 'normal', 'cats_lyrics/示例.mp3', '示例：猫猫按钮（改成音效名）', NULL, '2024年3月19日 23:59', '猫猫代播', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (18, 5, 5, 'normal', 'cats_lyrics/猫猫_1.mp3', '猫猫 · 第一声', NULL, '2024年3月19日 23:59', '猫猫代播 · 片段一', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (19, 5, 5, 'normal', 'cats_lyrics/猫猫_2.mp3', '猫猫 · 第二声', NULL, '2024年3月20日 00:02', '猫猫代播 · 片段二', NULL, '/thumbs/placeholder.svg', 1, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (26, 8, NULL, 'normal', 'songs/原创_示例1.mp3', '示例：原创曲目（改成歌名）', '渺渺渺', '2024年6月1日 19:00', '原创 · 第一首', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (27, 8, NULL, 'normal', 'songs/原创_示例2.mp3', '示例：原创曲目二（改成歌名）', '渺渺渺', '2024年6月2日 19:00', '原创 · 第二首', NULL, '/thumbs/placeholder.svg', 1, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (28, 9, NULL, 'normal', 'songs/原创_示例1.mp3', '示例：原创曲目（改成歌名）', '渺渺渺', '2024年6月1日 19:00', '原创 · 第一首', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (29, 9, NULL, 'normal', 'songs/原创_示例2.mp3', '示例：原创曲目二（改成歌名）', '渺渺渺', '2024年6月2日 19:00', '原创 · 第二首', NULL, '/thumbs/placeholder.svg', 1, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (30, 10, NULL, 'normal', 'songs/原创_示例1.mp3', '示例：原创曲目（改成歌名）', '渺渺渺', '2024年6月1日 19:00', '原创 · 第一首', NULL, '/thumbs/placeholder.svg', 0, 1);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (31, 10, NULL, 'normal', 'songs/原创_示例2.mp3', '示例：原创曲目二（改成歌名）', '渺渺渺', '2024年6月2日 19:00', '原创 · 第二首', NULL, '/thumbs/placeholder.svg', 1, 1);
INSERT INTO settings (key, value) VALUES ('song_empty_hint', '还没有歌曲哦，等主人有空放进 public/audio/songs 就能听啦');
INSERT INTO settings (key, value) VALUES ('voice_empty_hint', '还没有音效哦，等主人有空放进 public/audio 就能用啦');
COMMIT;
