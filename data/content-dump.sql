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
INSERT INTO stacks (id, group_id, title, sort_order, is_example) VALUES (16, 4, '怪叫合集（演示）', 0, 0);
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example, created_at, info_duration, info_uploader, info_songcut_text, special_effect) VALUES (123, 4, NULL, 'normal', 'noise/demo-1.mp3', '普通怪叫（无图标）', NULL, '2026年10月20日 20:00', '演示：不带特效', NULL, NULL, 0, 0, '2026-10-20 11:49:25', NULL, NULL, NULL, '0');
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example, created_at, info_duration, info_uploader, info_songcut_text, special_effect) VALUES (124, 4, NULL, 'normal', 'noise/demo-2.mp3', '特效怪叫（左侧有图标）', NULL, '2026年10月20日 20:01', '演示：带特效', NULL, NULL, 1, 0, '2026-10-20 11:49:25', NULL, NULL, NULL, '1');
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example, created_at, info_duration, info_uploader, info_songcut_text, special_effect) VALUES (125, 4, NULL, 'normal', 'noise/demo-3.mp3', '第二个特效示例', NULL, NULL, NULL, NULL, NULL, 2, 0, '2026-10-20 11:49:25', '12.5', '演示上传者', NULL, '1');
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example, created_at, info_duration, info_uploader, info_songcut_text, special_effect) VALUES (126, 5, NULL, 'normal', 'cats_lyrics/demo-1.mp3', '猫猫特效示例', NULL, NULL, '演示：猫猫组也有图标', NULL, NULL, 0, 0, '2026-10-20 11:49:25', NULL, NULL, NULL, '1');
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example, created_at, info_duration, info_uploader, info_songcut_text, special_effect) VALUES (127, 4, 16, 'normal', 'noise/stack-1.mp3', '合集成员（无图标）', NULL, NULL, NULL, NULL, NULL, 3, 0, '2026-10-20 11:49:26', NULL, NULL, NULL, '0');
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example, created_at, info_duration, info_uploader, info_songcut_text, special_effect) VALUES (128, 4, 16, 'normal', 'noise/stack-2.mp3', '合集成员（有图标）', NULL, NULL, NULL, NULL, NULL, 4, 0, '2026-10-20 11:49:26', NULL, NULL, NULL, '1');
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example, created_at, info_duration, info_uploader, info_songcut_text, special_effect) VALUES (129, 8, NULL, 'normal', 'songs/demo-1.mp3', '民谣示例·带特效', '示例歌手', NULL, NULL, NULL, NULL, 0, 0, '2026-10-20 11:49:26', NULL, NULL, '完整歌切见合集第二集，从副歌开始', '1');
INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example, created_at, info_duration, info_uploader, info_songcut_text, special_effect) VALUES (130, 8, NULL, 'normal', 'songs/demo-2.mp3', '民谣示例·普通', '示例歌手', NULL, NULL, NULL, NULL, 1, 0, '2026-10-20 11:49:26', NULL, NULL, NULL, '0');
INSERT INTO settings (key, value) VALUES ('song_empty_hint', '还没有歌曲哦，等主人有空放进 public/audio/songs 就能听啦');
INSERT INTO settings (key, value) VALUES ('voice_empty_hint', '还没有音效哦，等主人有空放进 public/audio 就能用啦');
DELETE FROM item_audio;
DELETE FROM audio_cleanup;
DELETE FROM audio_retired;
DELETE FROM sqlite_sequence WHERE name IN ('groups', 'stacks', 'items');
INSERT INTO sqlite_sequence (name, seq) VALUES ('groups', 23);
INSERT INTO sqlite_sequence (name, seq) VALUES ('items', 130);
INSERT INTO sqlite_sequence (name, seq) VALUES ('stacks', 16);
COMMIT;
