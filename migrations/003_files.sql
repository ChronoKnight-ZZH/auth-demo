-- 里程碑 3：附件原件元数据与引用
-- 兼容 MySQL 5.7 / 8.4。物理文件按 storage_key 内容寻址存放，
-- DB 只保存元数据与「文件 → 会话」引用，便于按用户导出与回收。

CREATE TABLE IF NOT EXISTS app_files (
  id                VARCHAR(64)     NOT NULL,
  owner_id          BIGINT UNSIGNED NOT NULL,
  sha256            CHAR(64)        NOT NULL,
  storage_key       CHAR(64)        NOT NULL COMMENT '实际路径键：global=sha256，user=HMAC(salt,sha256)',
  size              BIGINT UNSIGNED NOT NULL,
  mime              VARCHAR(128)    NOT NULL DEFAULT '',
  name              VARCHAR(255)    NOT NULL DEFAULT '',
  is_image          TINYINT(1)      NOT NULL DEFAULT 0,
  created_at        BIGINT          NOT NULL,
  deleted_at        BIGINT          NULL,
  PRIMARY KEY (id),
  KEY idx_app_files_owner (owner_id, created_at),
  KEY idx_app_files_sha (owner_id, sha256),
  KEY idx_app_files_storage (storage_key),
  CONSTRAINT fk_app_files_owner
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_file_refs (
  file_id           VARCHAR(64)     NOT NULL,
  session_id        VARCHAR(64)     NOT NULL,
  user_id           BIGINT UNSIGNED NOT NULL,
  created_at        BIGINT          NOT NULL,
  deleted_at        BIGINT          NULL,
  PRIMARY KEY (file_id, session_id),
  KEY idx_app_file_refs_session (session_id, user_id),
  CONSTRAINT fk_app_file_refs_file
    FOREIGN KEY (file_id) REFERENCES app_files(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
