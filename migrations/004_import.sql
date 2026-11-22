-- 里程碑 4：账号管理与历史导入审计
-- import_jobs 记录每次 CLI 导入的人员、来源、结果与失败原因；
-- 不存文件内容，只存统计与来源指纹，便于追溯。

CREATE TABLE IF NOT EXISTS import_jobs (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  actor             VARCHAR(128)    NOT NULL COMMENT '执行 CLI 的操作系统账号',
  source            VARCHAR(512)    NOT NULL COMMENT '导入文件名或路径备注',
  source_sha256     CHAR(64)        NULL COMMENT 'ZIP 内容指纹，便于识别重复导入',
  mode              VARCHAR(16)     NOT NULL DEFAULT 'skip',
  status            ENUM('running','success','failed','dry_run') NOT NULL DEFAULT 'running',
  sessions_total    INT UNSIGNED    NOT NULL DEFAULT 0,
  sessions_imported INT UNSIGNED    NOT NULL DEFAULT 0,
  sessions_skipped  INT UNSIGNED    NOT NULL DEFAULT 0,
  files_imported    INT UNSIGNED    NOT NULL DEFAULT 0,
  bytes_imported    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error             VARCHAR(1000)   NULL,
  started_at        BIGINT          NOT NULL,
  finished_at       BIGINT          NULL,
  PRIMARY KEY (id),
  KEY idx_import_jobs_user (user_id, started_at),
  CONSTRAINT fk_import_jobs_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
