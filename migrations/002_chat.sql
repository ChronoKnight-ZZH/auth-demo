-- 里程碑 2：聊天会话与消息持久化
-- 兼容 MySQL 5.7 / 8.4；消息使用 JSON 保存，保留分支、版本、思考块与工具块。
-- 附件原件仍在后续里程碑落盘；本表只保存消息内已有的附件元数据。

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                VARCHAR(64)     NOT NULL,
  user_id           BIGINT UNSIGNED NOT NULL,
  title             VARCHAR(255)    NOT NULL DEFAULT '',
  root_message_id   VARCHAR(64)     NULL,
  messages          JSON            NOT NULL,
  created_at        BIGINT          NOT NULL,
  updated_at        BIGINT          NOT NULL,
  deleted_at        BIGINT          NULL,
  PRIMARY KEY (id),
  KEY idx_chat_sessions_user_updated (user_id, deleted_at, updated_at),
  CONSTRAINT fk_chat_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
