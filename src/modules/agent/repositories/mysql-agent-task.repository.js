'use strict';
/**
 * MySQL AgentTaskRepository。
 *
 * 全部 SQL 走 pool.execute 预处理；动态 SET 子句只来自固定列映射，
 * 不接受任何外部字段名。任务、输入文件快照在同一事务内写入。
 */
const mysql = require('mysql2/promise');
const { AgentTaskRepository } = require('./agent-task.repository');
const { config } = require('../../../config');

const TASK_COLUMNS = [
  'id', 'user_id', 'conversation_id', 'status', 'input_text', 'current_step',
  'result_text', 'error_code', 'error_message', 'idempotency_key',
  'model_calls', 'tool_calls', 'deadline_at', 'started_at', 'finished_at',
  'created_at', 'updated_at',
].join(', ');

const STEP_COLUMNS = [
  'id', 'task_id', 'step_index', 'step_type', 'tool_name', 'status',
  'input_summary', 'output_summary', 'error_code', 'started_at', 'finished_at',
  'duration_ms', 'created_at',
].join(', ');

const FILE_COLUMNS = [
  'id', 'task_id', 'user_id', 'file_id', 'file_role', 'file_name', 'file_type',
  'file_size', 'download_url', 'created_at',
].join(', ');

/** camelCase → 固定数据库列名；未知字段不会进入 SQL */
const TASK_PATCH = Object.freeze({
  status: 'status',
  currentStep: 'current_step',
  resultText: 'result_text',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  modelCalls: 'model_calls',
  toolCalls: 'tool_calls',
  deadlineAt: 'deadline_at',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  updatedAt: 'updated_at',
});

const STEP_PATCH = Object.freeze({
  stepType: 'step_type',
  toolName: 'tool_name',
  status: 'status',
  inputSummary: 'input_summary',
  outputSummary: 'output_summary',
  errorCode: 'error_code',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  durationMs: 'duration_ms',
});

function toTask(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    conversationId: row.conversation_id == null ? null : row.conversation_id,
    status: row.status,
    inputText: row.input_text,
    currentStep: row.current_step == null ? null : row.current_step,
    resultText: row.result_text == null ? null : row.result_text,
    errorCode: row.error_code == null ? null : row.error_code,
    errorMessage: row.error_message == null ? null : row.error_message,
    idempotencyKey: row.idempotency_key == null ? null : row.idempotency_key,
    modelCalls: Number(row.model_calls),
    toolCalls: Number(row.tool_calls),
    deadlineAt: row.deadline_at == null ? null : Number(row.deadline_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toStep(row) {
  return {
    id: Number(row.id),
    taskId: row.task_id,
    stepIndex: Number(row.step_index),
    stepType: row.step_type,
    toolName: row.tool_name == null ? null : row.tool_name,
    status: row.status,
    inputSummary: row.input_summary == null ? null : row.input_summary,
    outputSummary: row.output_summary == null ? null : row.output_summary,
    errorCode: row.error_code == null ? null : row.error_code,
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: Number(row.created_at),
  };
}

function toFile(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: Number(row.user_id),
    fileId: row.file_id == null ? null : row.file_id,
    fileRole: row.file_role,
    fileName: row.file_name,
    fileType: row.file_type,
    fileSize: Number(row.file_size),
    downloadUrl: row.download_url == null ? null : row.download_url,
    createdAt: Number(row.created_at),
  };
}

function buildPatch(patch, columns) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    sets.push(`${column} = ?`);
    values.push(patch[key]);
  }
  return { sets, values };
}

class MysqlAgentTaskRepository extends AgentTaskRepository {
  constructor(url) {
    super();
    this.pool = mysql.createPool({
      uri: url || config.mysql.url,
      waitForConnections: true,
      connectionLimit: config.agent.mysqlPoolSize,
      timezone: 'Z',
      dateStrings: false,
      namedPlaceholders: false,
    });
  }

  async ping() {
    const conn = await this.pool.getConnection();
    try {
      await conn.query('SELECT 1');
      return true;
    } finally {
      conn.release();
    }
  }

  async createTask(task, files = []) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO agent_tasks
           (id, user_id, conversation_id, status, input_text, current_step,
            result_text, error_code, error_message, idempotency_key,
            model_calls, tool_calls, deadline_at, started_at, finished_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.userId,
          task.conversationId,
          task.status,
          task.inputText,
          task.currentStep ?? null,
          task.resultText ?? null,
          task.errorCode ?? null,
          task.errorMessage ?? null,
          task.idempotencyKey ?? null,
          task.modelCalls ?? 0,
          task.toolCalls ?? 0,
          task.deadlineAt ?? null,
          task.startedAt ?? null,
          task.finishedAt ?? null,
          task.createdAt,
          task.updatedAt ?? task.createdAt,
        ]
      );
      for (const file of files) {
        await conn.execute(
          `INSERT INTO agent_task_files
             (id, task_id, user_id, file_id, file_role, file_name, file_type,
              file_size, download_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            file.id,
            file.taskId,
            file.userId,
            file.fileId ?? null,
            file.fileRole,
            file.fileName,
            file.fileType,
            file.fileSize,
            file.downloadUrl ?? null,
            file.createdAt,
          ]
        );
      }
      await conn.commit();
      return this.getTaskById(task.id);
    } catch (error) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw error;
    } finally {
      conn.release();
    }
  }

  async getTask(userId, id) {
    const [rows] = await this.pool.execute(
      `SELECT ${TASK_COLUMNS} FROM agent_tasks
        WHERE id = ? AND user_id = ?
        LIMIT 1`,
      [id, userId]
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async getTaskById(id) {
    const [rows] = await this.pool.execute(
      `SELECT ${TASK_COLUMNS} FROM agent_tasks WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async findByIdempotencyKey(userId, key) {
    if (!key) return null;
    const [rows] = await this.pool.execute(
      `SELECT ${TASK_COLUMNS} FROM agent_tasks
        WHERE user_id = ? AND idempotency_key = ?
        LIMIT 1`,
      [userId, key]
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async transitionTask(id, fromStatuses, patch) {
    if (!Array.isArray(fromStatuses) || fromStatuses.length === 0) return null;
    const next = { ...patch };
    if (next.updatedAt === undefined) next.updatedAt = Date.now();
    const { sets, values } = buildPatch(next, TASK_PATCH);
    if (sets.length === 0) return this.getTaskById(id);
    const placeholders = fromStatuses.map(() => '?').join(',');
    const [result] = await this.pool.execute(
      `UPDATE agent_tasks SET ${sets.join(', ')}
        WHERE id = ? AND status IN (${placeholders})`,
      [...values, id, ...fromStatuses]
    );
    return result.affectedRows === 1 ? this.getTaskById(id) : null;
  }

  async updateTask(id, patch) {
    const next = { ...patch };
    if (next.updatedAt === undefined) next.updatedAt = Date.now();
    const { sets, values } = buildPatch(next, TASK_PATCH);
    if (sets.length === 0) return this.getTaskById(id);
    const [result] = await this.pool.execute(
      `UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`,
      [...values, id]
    );
    return result.affectedRows === 1 ? this.getTaskById(id) : null;
  }

  async listSteps(taskId) {
    const [rows] = await this.pool.execute(
      `SELECT ${STEP_COLUMNS} FROM agent_task_steps
        WHERE task_id = ?
        ORDER BY step_index ASC`,
      [taskId]
    );
    return rows.map(toStep);
  }

  async appendStep(step) {
    let stepIndex = step.stepIndex;
    if (stepIndex == null) {
      const [[row]] = await this.pool.execute(
        `SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index
           FROM agent_task_steps WHERE task_id = ?`,
        [step.taskId]
      );
      stepIndex = Number(row.next_index);
    }
    await this.pool.execute(
      `INSERT INTO agent_task_steps
         (task_id, step_index, step_type, tool_name, status, input_summary,
          output_summary, error_code, started_at, finished_at, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         step_type = ?, tool_name = ?, status = ?, input_summary = ?,
         output_summary = ?, error_code = ?, started_at = ?, finished_at = ?,
         duration_ms = ?`,
      [
        step.taskId, stepIndex, step.stepType, step.toolName ?? null, step.status,
        step.inputSummary ?? null, step.outputSummary ?? null, step.errorCode ?? null,
        step.startedAt ?? null, step.finishedAt ?? null, step.durationMs ?? null,
        step.createdAt ?? Date.now(),
        step.stepType, step.toolName ?? null, step.status,
        step.inputSummary ?? null, step.outputSummary ?? null, step.errorCode ?? null,
        step.startedAt ?? null, step.finishedAt ?? null, step.durationMs ?? null,
      ]
    );
    const steps = await this.listSteps(step.taskId);
    return steps.find((item) => item.stepIndex === stepIndex) ?? null;
  }

  async updateStep(taskId, stepIndex, patch) {
    const { sets, values } = buildPatch(patch, STEP_PATCH);
    if (sets.length === 0) return null;
    const [result] = await this.pool.execute(
      `UPDATE agent_task_steps SET ${sets.join(', ')}
        WHERE task_id = ? AND step_index = ?`,
      [...values, taskId, stepIndex]
    );
    if (result.affectedRows !== 1) return null;
    const steps = await this.listSteps(taskId);
    return steps.find((item) => item.stepIndex === stepIndex) ?? null;
  }

  async listFiles(taskId) {
    const [rows] = await this.pool.execute(
      `SELECT ${FILE_COLUMNS} FROM agent_task_files
        WHERE task_id = ?
        ORDER BY created_at ASC, id ASC`,
      [taskId]
    );
    return rows.map(toFile);
  }

  async addFile(file) {
    await this.pool.execute(
      `INSERT INTO agent_task_files
         (id, task_id, user_id, file_id, file_role, file_name, file_type,
          file_size, download_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.id, file.taskId, file.userId, file.fileId ?? null, file.fileRole,
        file.fileName, file.fileType, file.fileSize, file.downloadUrl ?? null,
        file.createdAt,
      ]
    );
    return file;
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { MysqlAgentTaskRepository };
