-- Agent Harness 阶段 1：任务、步骤、文件
-- 兼容 MySQL 5.7 / 8.4；时间戳统一 BIGINT 毫秒，避免时区差异。
-- 所有表按 user_id 隔离；跨用户查询必须同时带 user_id。

CREATE TABLE IF NOT EXISTS agent_tasks (
  id                VARCHAR(64)     NOT NULL,
  user_id           BIGINT UNSIGNED NOT NULL,
  conversation_id   VARCHAR(64)     NULL,
  status            ENUM('queued','running','waiting_model','completed','failed','cancelled','timed_out')
                                    NOT NULL DEFAULT 'queued',
  input_text        MEDIUMTEXT      NOT NULL,
  current_step      VARCHAR(64)     NULL,
  result_text       MEDIUMTEXT      NULL,
  error_code        VARCHAR(64)     NULL,
  error_message     VARCHAR(1024)   NULL,
  idempotency_key   VARCHAR(128)    COLLATE utf8mb4_bin NULL,
  model_calls       INT UNSIGNED    NOT NULL DEFAULT 0,
  tool_calls        INT UNSIGNED    NOT NULL DEFAULT 0,
  deadline_at       BIGINT          NULL,
  started_at        BIGINT          NULL,
  finished_at       BIGINT          NULL,
  created_at        BIGINT          NOT NULL,
  updated_at        BIGINT          NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_agent_tasks_user_idem (user_id, idempotency_key),
  KEY idx_agent_tasks_user_created (user_id, created_at),
  KEY idx_agent_tasks_status_created (status, created_at),
  CONSTRAINT fk_agent_tasks_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_task_steps (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id           VARCHAR(64)     NOT NULL,
  step_index        INT UNSIGNED    NOT NULL,
  step_type         ENUM('model','tool') NOT NULL,
  tool_name         VARCHAR(64)     NULL,
  status            ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
  input_summary     TEXT            NULL,
  output_summary    TEXT            NULL,
  error_code        VARCHAR(64)     NULL,
  started_at        BIGINT          NULL,
  finished_at       BIGINT          NULL,
  duration_ms       INT UNSIGNED    NULL,
  created_at        BIGINT          NOT NULL,
  PRIMARY KEY (id),
  -- 唯一键已覆盖 (task_id, step_index)，无需再建同前缀普通索引
  UNIQUE KEY uk_agent_steps_task_index (task_id, step_index),
  CONSTRAINT fk_agent_steps_task
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_task_files (
  id                VARCHAR(64)     NOT NULL,
  task_id           VARCHAR(64)     NOT NULL,
  user_id           BIGINT UNSIGNED NOT NULL,
  file_id           VARCHAR(64)     NULL COMMENT 'app_files.id；intermediate 可为空',
  file_role         ENUM('input','output','intermediate') NOT NULL,
  file_name         VARCHAR(255)    NOT NULL,
  file_type         VARCHAR(128)    NOT NULL DEFAULT '',
  file_size         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  download_url      VARCHAR(1024)   NULL,
  created_at        BIGINT          NOT NULL,
  PRIMARY KEY (id),
  KEY idx_agent_files_task_role (task_id, file_role),
  KEY idx_agent_files_user_created (user_id, created_at),
  CONSTRAINT fk_agent_files_task
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
