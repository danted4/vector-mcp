// ==========================================
// Job Manager - Asynchronous Task Coordination
// ==========================================
// Manages long-running tasks with progress tracking, logging, and status monitoring
// Provides job lifecycle management for indexing and other background operations

import { logger } from '../logger/logger.js';

/**
 * Manages asynchronous jobs with progress tracking and logging
 * Provides a centralized system for monitoring long-running operations like indexing
 */
export class JobManager {
  /**
   * Creates a new JobManager instance
   * Initializes job storage and ID counter for unique job identification
   */
  constructor() {
    /** @type {Map<string, Object>} In-memory storage for active and recent jobs */
    this.jobs = new Map();
    
    /** @type {number} Incrementing counter for unique job ID generation */
    this.jobId = 0;
  }

  /**
   * Creates a new job with initial status and metadata
   * Generates unique ID and sets up job tracking structure
   * @param {string} type - Job type ('index', 'update', 'delete')
   * @param {string} projectId - Associated project identifier
   * @param {Object} [params={}] - Additional job parameters
   * @returns {Object} Created job object with initial status
   */
  createJob(type, projectId, params = {}) {
    // Generate unique job ID with timestamp for uniqueness
    const jobId = `job_${++this.jobId}_${Date.now()}`;
    
    const job = {
      id: jobId,
      type,                    // Job type for categorization
      projectId,              // Associated project
      status: 'pending',      // Current status: 'pending', 'running', 'completed', 'failed'
      progress: 0,            // Completion percentage (0-100)
      startTime: new Date(),  // Job creation timestamp
      endTime: null,          // Completion timestamp (set when finished)
      result: null,           // Final result data
      error: null,            // Error message if failed
      params,                 // Job-specific parameters
      logs: [],              // Array of log entries for this job
      stats: {               // Statistical information
        filesTotal: 0,
        filesProcessed: 0,
        chunksIndexed: 0,
        deltaStats: null     // Delta-specific statistics
      }
    };

    this.jobs.set(jobId, job);
    logger.info(`Created job ${jobId} for ${type} on project ${projectId}`, { jobId, projectId, type });
    
    return job;
  }

  /**
   * Retrieves a job by its unique identifier
   * @param {string} jobId - Job ID to look up
   * @returns {Object|undefined} Job object or undefined if not found
   */
  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  /**
   * Updates job properties and handles status transitions
   * Automatically sets endTime when job reaches completion or failure
   * @param {string} jobId - Job ID to update
   * @param {Object} updates - Properties to update on the job
   * @returns {Object|null} Updated job object or null if not found
   */
  updateJob(jobId, updates) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    // Apply updates to job object
    Object.assign(job, updates);
    
    // Set completion timestamp for finished jobs
    if (updates.status === 'completed' || updates.status === 'failed') {
      job.endTime = new Date();
      job.duration = job.endTime - job.startTime; // Calculate total duration
    }

    return job;
  }

  /**
   * Adds a log entry to a specific job and writes to server log
   * Maintains job-specific log history while also feeding global log stream
   * @param {string} jobId - Job ID to add log entry to
   * @param {string} message - Log message content
   * @param {string} [level='info'] - Log level ('info', 'success', 'warn', 'error')
   */
  addJobLog(jobId, message, level = 'info') {
    const job = this.jobs.get(jobId);
    if (!job) return;

    // Create structured log entry
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      jobId,
      projectId: job.projectId
    };

    job.logs.push(logEntry);

    // Write to server log file (streams to UI automatically)
    if (typeof logger !== 'undefined' && logger.job) {
      logger.job(jobId, message, level, { projectId: job.projectId });
    } else {
      // Fallback logging if logger is not available
      console.log(`[${jobId.substr(-8)}] ${message}`);
    }

    // Limit log history to prevent memory bloat (keep last 50 entries)
    if (job.logs.length > 50) {
      job.logs.splice(0, job.logs.length - 50);
    }
  }

  /**
   * Updates job progress percentage and optionally logs a status message
   * Ensures progress stays within 0-100 bounds
   * @param {string} jobId - Job ID to update progress for
   * @param {number} progress - Progress percentage (0-100)
   * @param {string} [message] - Optional progress message to log
   */
  updateProgress(jobId, progress, message = null) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    // Clamp progress to valid range
    job.progress = Math.min(100, Math.max(0, progress));
    
    // Log progress message if provided
    if (message) {
      this.addJobLog(jobId, message);
    }
  }

  /**
   * Gets all jobs sorted by start time (newest first)
   * Used for job history and monitoring interfaces
   * @returns {Object[]} Array of all jobs sorted by start time descending
   */
  getAllJobs() {
    return Array.from(this.jobs.values()).sort((a, b) => b.startTime - a.startTime);
  }

  /**
   * Gets only currently active jobs (pending or running)
   * Used for monitoring ongoing operations
   * @returns {Object[]} Array of active jobs
   */
  getActiveJobs() {
    return Array.from(this.jobs.values()).filter(job => 
      job.status === 'pending' || job.status === 'running'
    );
  }

  /**
   * Removes old completed jobs to prevent memory accumulation
   * Called periodically to clean up job history beyond retention period
   * @param {number} [maxAge=86400000] - Maximum age in milliseconds (default: 24 hours)
   * @returns {number} Number of jobs cleaned up
   */
  cleanupOldJobs(maxAge = 24 * 60 * 60 * 1000) { // 24 hours default
    const cutoff = new Date(Date.now() - maxAge);
    let cleaned = 0;

    // Remove jobs that completed before the cutoff time
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.endTime && job.endTime < cutoff) {
        this.jobs.delete(jobId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old jobs`);
    }
    
    return cleaned;
  }

  /**
   * Executes an indexing job with integrated progress tracking and logging
   * Wrapper around FileIndexer that provides job-aware progress updates
   * @param {string} jobId - Job ID to execute
   * @param {FileIndexer} fileIndexer - File indexer instance to use
   * @param {string} directoryPath - Directory to index
   * @param {string} projectId - Project identifier
   * @param {string[]} excludePatterns - Patterns to exclude from indexing
   * @param {boolean} deltaOnly - Whether to perform delta-only indexing
   * @returns {Promise<Object>} Indexing result with statistics
   * @throws {Error} If indexing fails or job not found
   */
  async runIndexJob(jobId, fileIndexer, directoryPath, projectId, excludePatterns, deltaOnly) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    try {
      // Mark job as actively running
      this.updateJob(jobId, { status: 'running' });

      // Execute indexing with job-aware progress tracking
      // FileIndexer will call back to this job manager for progress updates
      const result = await fileIndexer.indexDirectory(
        directoryPath, 
        projectId, 
        excludePatterns, 
        deltaOnly, 
        jobId  // Pass job ID for progress callbacks
      );

      // Mark job as completed with results
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

      // Log completion summary
      this.addJobLog(jobId, `Indexing completed successfully`, 'success');
      this.addJobLog(jobId, `Files processed: ${result.filesProcessed}, Chunks indexed: ${result.chunksIndexed}`, 'success');

      // Log delta statistics if available
      if (result.deltaStats) {
        this.addJobLog(jobId, 
          `Delta stats: ${result.deltaStats.skipped} skipped, ${result.deltaStats.updated} updated, ${result.deltaStats.added} added, ${result.deltaStats.deleted} deleted`, 
          'success'
        );
      }

      return result;

    } catch (error) {
      // Mark job as failed with error details
      this.updateJob(jobId, { 
        status: 'failed', 
        error: error.message,
        progress: 0
      });
      
      this.addJobLog(jobId, `Indexing failed: ${error.message}`, 'error');
      throw error; // Re-throw for upstream error handling
    }
  }
}