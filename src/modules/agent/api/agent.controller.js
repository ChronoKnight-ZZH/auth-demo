'use strict';
/**
 * Agent HTTP 控制器。
 * 对外字段使用 snake_case，与方案中的接口示例保持一致。
 */
const { parseCreateTask, parseTaskId } = require('./agent.validator');

function toFileResponse(file) {
  return {
    id: file.id,
    file_id: file.fileId,
    file_role: file.fileRole,
    file_name: file.fileName,
    file_type: file.fileType,
    file_size: file.fileSize,
    download_url: file.downloadUrl,
    created_at: file.createdAt,
  };
}

function toStepResponse(step) {
  return {
    step_index: step.stepIndex,
    step_type: step.stepType,
    tool_name: step.toolName,
    status: step.status,
    input_summary: step.inputSummary,
    output_summary: step.outputSummary,
    error_code: step.errorCode,
    started_at: step.startedAt,
    finished_at: step.finishedAt,
    duration_ms: step.durationMs,
  };
}

function toTaskResponse(task, { steps = [], files = [] } = {}) {
  return {
    task_id: task.id,
    status: task.status,
    current_step: task.currentStep,
    conversation_id: task.conversationId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    deadline_at: task.deadlineAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    result: task.resultText ? { text: task.resultText } : null,
    error: task.errorCode
      ? { code: task.errorCode, message: task.errorMessage || '' }
      : null,
    progress: {
      completed_steps: steps.filter((step) => step.status === 'completed').length,
      total_steps: null,
    },
    files: files.map(toFileResponse),
    status_url: `/api/agent/tasks/${task.id}`,
  };
}

function createAgentController({ createTask, getTaskService, cancelTask, featureGate }) {
  return {
    async create(req, res) {
      featureGate.assertAllowed(req.userId);
      const input = parseCreateTask(req.body, req.headers);
      const task = await createTask(req.userId, input);
      return res.status(202).json(toTaskResponse(task));
    },

    async get(req, res) {
      featureGate.assertAllowed(req.userId);
      const taskId = parseTaskId(req.params.taskId);
      const { task, steps, files } = await getTaskService.getTask(req.userId, taskId);
      return res.json(toTaskResponse(task, { steps, files }));
    },

    async cancel(req, res) {
      featureGate.assertAllowed(req.userId);
      const taskId = parseTaskId(req.params.taskId);
      const result = await cancelTask(req.userId, taskId);
      return res.json({
        ok: true,
        cancelled: result.cancelled,
        task: toTaskResponse(result.task),
      });
    },

    async steps(req, res) {
      featureGate.assertAllowed(req.userId);
      const taskId = parseTaskId(req.params.taskId);
      const steps = await getTaskService.listSteps(req.userId, taskId);
      return res.json({ task_id: taskId, steps: steps.map(toStepResponse) });
    },

    async files(req, res) {
      featureGate.assertAllowed(req.userId);
      const taskId = parseTaskId(req.params.taskId);
      const files = await getTaskService.listFiles(req.userId, taskId);
      return res.json({ task_id: taskId, files: files.map(toFileResponse) });
    },

    async file(req, res) {
      featureGate.assertAllowed(req.userId);
      const taskId = parseTaskId(req.params.taskId);
      const fileId = parseTaskId(req.params.fileId);
      const file = await getTaskService.getFile(req.userId, taskId, fileId);
      return res.json({ task_id: taskId, file: toFileResponse(file) });
    },
  };
}

module.exports = {
  createAgentController,
  toTaskResponse,
  toStepResponse,
  toFileResponse,
};
