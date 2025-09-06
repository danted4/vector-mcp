import { logger } from '../logger/logger.js';

export class JobManager {
  constructor() {
    this.jobs = new Map();
    this.jobId = 0;
  }

  createJob(type, projectId, params = {}) {
    const jobId = `job_${++this.jobId}_${Date.now()}`;
    const job = {
      id: jobId,
      type, // 'index', 'update', 'delete'
      projectId,
      status: 'pending', // 'pending', 'running', 'completed', 'failed'
      progress: 0, // 0-100
      startTime: new Date(),
      endTime: null,
      result: null,
      error: null,
      params,
      logs: [],
      stats: {
        filesTotal: 0,
        filesProcessed: 0,
        chunksIndexed: 0,
        deltaStats: null
      }
    };

    this.jobs.set(jobId, job);
    logger.info(`Created job ${jobId} for ${type} on project ${projectId}`, { jobId, projectId, type });
    return job;
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  updateJob(jobId, updates) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    Object.assign(job, updates);
    
    if (updates.status === 'completed' || updates.status === 'failed') {
      job.endTime = new Date();
      job.duration = job.endTime - job.startTime;
    }

    return job;
  }

  addJobLog(jobId, message, level = 'info') {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      jobId,
      projectId: job.projectId
    };

    job.logs.push(logEntry);

    // Write to server.log file (this will automatically stream to UI)
    if (typeof logger !== 'undefined' && logger.job) {
      logger.job(jobId, message, level, { projectId: job.projectId });
    } else {
      // Fallback if logger not available
      console.log(`[${jobId.substr(-8)}] ${message}`);
    }

    // Keep only last 50 log entries to prevent memory issues
    if (job.logs.length > 50) {
      job.logs.splice(0, job.logs.length - 50);
    }
  }

  updateProgress(jobId, progress, message = null) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.progress = Math.min(100, Math.max(0, progress));
    if (message) {
      this.addJobLog(jobId, message);
    }
  }

  getAllJobs() {
    return Array.from(this.jobs.values()).sort((a, b) => b.startTime - a.startTime);
  }

  getActiveJobs() {
    return Array.from(this.jobs.values()).filter(job => 
      job.status === 'pending' || job.status === 'running'
    );
  }

  cleanupOldJobs(maxAge = 24 * 60 * 60 * 1000) { // 24 hours default
    const cutoff = new Date(Date.now() - maxAge);
    let cleaned = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.endTime && job.endTime < cutoff) {
        this.jobs.delete(jobId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old jobs`);
    }
  }

  // Enhanced indexing wrapper with progress tracking
  async runIndexJob(jobId, fileIndexer, directoryPath, projectId, excludePatterns, deltaOnly) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    try {
      this.updateJob(jobId, { status: 'running' });

      // Pass jobId to FileIndexer so it can use job-specific logging
      const result = await fileIndexer.indexDirectory(directoryPath, projectId, excludePatterns, deltaOnly, jobId);

      this.updateJob(jobId, { 
        status: 'completed', 
        result,
        progress: 100,
        stats: {
          filesTotal: result.filesTotal || result.filesProcessed,
          filesProcessed: result.filesProcessed,
          chunksIndexed: result.chunksIndexed,
          deltaStats: result.deltaStats
        }
      });

      this.addJobLog(jobId, `Indexing completed successfully`, 'success');
      this.addJobLog(jobId, `Files processed: ${result.filesProcessed}, Chunks indexed: ${result.chunksIndexed}`, 'success');

      if (result.deltaStats) {
        this.addJobLog(jobId, `Delta stats: ${result.deltaStats.skipped} skipped, ${result.deltaStats.updated} updated, ${result.deltaStats.added} added, ${result.deltaStats.deleted} deleted`, 'success');
      }

      return result;

    } catch (error) {
      this.updateJob(jobId, { 
        status: 'failed', 
        error: error.message,
        progress: 0
      });
      this.addJobLog(jobId, `Indexing failed: ${error.message}`, 'error');
      throw error;
    }
  }
}