// ==========================================
// Structured Logger - File and Console Output
// ==========================================
// Provides structured logging with emoji-enhanced console output and file persistence
// Supports real-time log streaming and job-specific logging with context

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES6 module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Structured logger with file persistence and real-time streaming support
 * Provides emoji-enhanced console output and structured file logging
 */
export class Logger {
  /**
   * Creates a new Logger instance with specified log file
   * @param {string} [logFile='server.log'] - Log file name (relative to logger directory)
   */
  constructor(logFile = 'server.log') {
    /** @type {string} Full path to the log file */
    this.logFile = path.join(__dirname, logFile);
    
    // Ensure log file exists on initialization
    this.ensureLogFile();
  }

  /**
   * Ensures the log file exists, creating it if necessary
   * Called during initialization and before each write operation
   */
  ensureLogFile() {
    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, '', 'utf8');
    }
  }

  /**
   * Formats a log message with timestamp and context information
   * Creates structured log entries suitable for file storage and parsing
   * @param {string} level - Log level (info, success, warn, error, debug)
   * @param {string} message - Primary log message
   * @param {Object} [context={}] - Additional context data
   * @returns {string} Formatted log message with timestamp and context
   */
  formatMessage(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const contextStr = Object.keys(context).length > 0 ? ` [${JSON.stringify(context)}]` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${contextStr}\n`;
  }

  /**
   * Writes a formatted message to the log file
   * Includes error recovery mechanism for file system issues
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} [context={}] - Additional context data
   */
  writeToFile(level, message, context = {}) {
    const formattedMessage = this.formatMessage(level, message, context);
    
    try {
      // Ensure log file exists before writing
      this.ensureLogFile();
      fs.appendFileSync(this.logFile, formattedMessage, 'utf8');
    } catch (error) {
      console.error('Failed to write to log file:', error);
      
      // Attempt recovery by recreating file and retrying
      try {
        this.ensureLogFile();
        fs.appendFileSync(this.logFile, formattedMessage, 'utf8');
      } catch (retryError) {
        console.error('Failed to write to log file on retry:', retryError);
      }
    }
  }

  /**
   * Logs an informational message
   * Uses ℹ️ emoji for console output and structured format for file
   * @param {string} message - Message to log
   * @param {Object} [context={}] - Additional context data
   */
  info(message, context = {}) {
    this.writeToFile('info', message, context);
    console.log(`ℹ️ ${message}`);
  }

  /**
   * Logs a success message
   * Uses ✅ emoji for console output to highlight successful operations
   * @param {string} message - Success message to log
   * @param {Object} [context={}] - Additional context data
   */
  success(message, context = {}) {
    this.writeToFile('success', message, context);
    console.log(`✅ ${message}`);
  }

  /**
   * Logs a warning message
   * Uses ⚠️ emoji for console output to highlight potential issues
   * @param {string} message - Warning message to log
   * @param {Object} [context={}] - Additional context data
   */
  warn(message, context = {}) {
    this.writeToFile('warn', message, context);
    console.warn(`⚠️ ${message}`);
  }

  /**
   * Logs an error message
   * Uses ❌ emoji for console output to highlight failures
   * @param {string} message - Error message to log
   * @param {Object} [context={}] - Additional context data
   */
  error(message, context = {}) {
    this.writeToFile('error', message, context);
    console.error(`❌ ${message}`);
  }

  /**
   * Logs a debug message
   * Uses 🐛 emoji for console output to identify debugging information
   * @param {string} message - Debug message to log
   * @param {Object} [context={}] - Additional context data
   */
  debug(message, context = {}) {
    this.writeToFile('debug', message, context);
    console.log(`🐛 ${message}`);
  }

  /**
   * Logs a job-specific message with job ID context
   * Provides abbreviated job ID for readability while maintaining full ID in file
   * @param {string} jobId - Full job identifier
   * @param {string} message - Job-related message
   * @param {string} [level='info'] - Log level (info, success, warn, error, debug)
   * @param {Object} [context={}] - Additional context data
   */
  job(jobId, message, level = 'info', context = {}) {
    const jobContext = { jobId, ...context };
    
    // Write to file with full job ID and context
    this.writeToFile(level, `[${jobId.substr(-8)}] ${message}`, jobContext);
    
    // Console output with emoji and abbreviated job ID
    const emoji = {
      'info': 'ℹ️',
      'success': '✅', 
      'error': '❌',
      'warn': '⚠️',
      'debug': '🐛'
    }[level] || 'ℹ️';
    
    console.log(`${emoji} [${jobId.substr(-8)}] ${message}`);
  }

  /**
   * Retrieves recent log entries from the log file
   * Used for providing historical context when clients connect to log stream
   * @param {number} [lines=100] - Number of recent lines to retrieve
   * @returns {Promise<string[]>} Array of recent log lines
   */
  async getRecentLogs(lines = 100) {
    try {
      const content = await fs.promises.readFile(this.logFile, 'utf8');
      const allLines = content.trim().split('\n').filter(line => line.length > 0);
      return allLines.slice(-lines);
    } catch (error) {
      // Return empty array if file doesn't exist or can't be read
      return [];
    }
  }

  /**
   * Clears the log file and logs the clearing action
   * Used for log management and cleanup operations
   * @returns {boolean} True if clearing succeeded, false otherwise
   */
  clear() {
    try {
      fs.writeFileSync(this.logFile, '', 'utf8');
      
      // Add a log entry about the clearing (this will appear in the stream)
      this.info('🧹 Server logs cleared - monitoring continues');
      return true;
    } catch (error) {
      console.error('Failed to clear log file:', error);
      this.error('Failed to clear log file', { error: error.message });
      return false;
    }
  }
}

// ==========================================
// Singleton Export
// ==========================================

/**
 * Singleton logger instance for application-wide use
 * Provides consistent logging interface across all modules
 * @type {Logger}
 */
export const logger = new Logger();