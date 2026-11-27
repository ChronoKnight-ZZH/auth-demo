'use strict';
/**
 * 现有本地文件服务适配器。
 *
 * 阶段 1 只实现“授权读取 + 复制到任务目录”；输出归档在阶段 4 接入。
 * 底层复用 Mysql/Memory FileRepo 与 blob-store，不直接拼 app_files 表。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../../../lib/errors');
const { config } = require('../../../config');
const defaultBlobStore = require('../../../files/blob-store');

class FileServiceAdapter {
  constructor({ fileRepo, blobStore = defaultBlobStore }) {
    if (!fileRepo) throw new Error('FileServiceAdapter requires fileRepo');
    this.fileRepo = fileRepo;
    this.blobStore = blobStore;
  }

  async getAuthorizedFile(userId, fileId) {
    const file = await this.fileRepo.get(userId, fileId);
    if (!file) throw new AppError('FILE_ACCESS_DENIED');
    return file;
  }

  async getMetadata(userId, fileId) {
    const file = await this.getAuthorizedFile(userId, fileId);
    return {
      fileId: file.id,
      name: file.name,
      mime: file.mime,
      size: Number(file.size) || 0,
      isImage: Boolean(file.isImage),
    };
  }

  /**
   * 把授权文件复制到任务 input 目录。
   * 目的路径必须由 WorkspaceManager 生成，且写入时再次限制字节数。
   */
  async copyInputToWorkspace(userId, fileId, destination, { maxBytes = config.agent.maxInputBytes } = {}) {
    const file = await this.getAuthorizedFile(userId, fileId);
    if ((Number(file.size) || 0) > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');

    const blob = await this.blobStore.stat(file.storageKey);
    if (!blob) throw new AppError('FILE_ACCESS_DENIED');
    if (blob.size > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');

    await fsp.mkdir(path.dirname(destination), { recursive: true });
    let written = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length;
        if (written > maxBytes) {
          callback(new AppError('PAYLOAD_TOO_LARGE'));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      this.blobStore.createReadStream(file.storageKey),
      counter,
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    );

    return { file, bytes: written };
  }

  /** 阶段 4：把 output 目录中的文件写入现有 app_files + blob-store */
  async storeOutput() {
    throw new AppError('AGENT_EXECUTOR_UNAVAILABLE');
  }
}

module.exports = { FileServiceAdapter };
