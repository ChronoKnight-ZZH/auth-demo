-- 后端登录与凭证验证 Demo —— MySQL 8.4 初始化脚本
-- 对应方案 §6.1.1。InnoDB + utf8mb4_0900_ai_ci。

CREATE TABLE IF NOT EXISTS users (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username            VARCHAR(64)     NOT NULL,
  password_hash       VARCHAR(255)    NOT NULL COMMENT '仅存 Argon2id PHC 字符串',
  credential_version  INT UNSIGNED    NOT NULL DEFAULT 1,
  argon2_key_version  TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'pepper 版本',
  status              ENUM('active','locked') NOT NULL DEFAULT 'active',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
