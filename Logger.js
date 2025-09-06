import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Logger {
  constructor(logFile = 'server.log') {
    this.logFile = path.join(__dirname, logFile);
    this.ensureLogFile();
  }

  ensureLogFile() {
    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, '', 'utf8');
    }
  }

  formatMessage(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const contextStr = Object.keys(context).length > 0 ? ` [${JSON.stringify(context)}]` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${contextStr}\n`;
  }

  writeToFile(level, message, context = {}) {
    const formattedMessage = this.formatMessage(level, message, context);
    
    try {
      // Ensure log file exists before writing
      this.ensureLogFile();
      fs.appendFileSync(this.logFile, formattedMessage, 'utf8');
    } catch (error) {
      console.error('Failed to write to log file:', error);
      // Try to recreate the file and write again
      try {
        this.ensureLogFile();
        fs.appendFileSync(this.logFile, formattedMessage, 'utf8');
      } catch (retryError) {
        console.error('Failed to write to log file on retry:', retryError);
      }
    }
  }

  info(message, context = {}) {
    this.writeToFile('info', message, context);
    console.log(`ℹ️ ${message}`);
  }

  success(message, context = {}) {
    this.writeToFile('success', message, context);
    console.log(`✅ ${message}`);
  }

  warn(message, context = {}) {
    this.writeToFile('warn', message, context);
    console.warn(`⚠️ ${message}`);
  }

  error(message, context = {}) {
    this.writeToFile('error', message, context);
    console.error(`❌ ${message}`);
  }

  debug(message, context = {}) {
    this.writeToFile('debug', message, context);
    console.log(`🐛 ${message}`);
  }

  job(jobId, message, level = 'info', context = {}) {
    const jobContext = { jobId, ...context };
    this.writeToFile(level, `[${jobId.substr(-8)}] ${message}`, jobContext);
    
    // Also log to console with job prefix
    const emoji = {
      'info': 'ℹ️',
      'success': '✅', 
      'error': '❌',
      'warn': '⚠️',
      'debug': '🐛'
    }[level] || 'ℹ️';
    
    console.log(`${emoji} [${jobId.substr(-8)}] ${message}`);
  }

  // Get recent log entries from file
  async getRecentLogs(lines = 100) {
    try {
      const content = await fs.promises.readFile(this.logFile, 'utf8');
      const allLines = content.trim().split('\n').filter(line => line.length > 0);
      return allLines.slice(-lines);
    } catch (error) {
      return [];
    }
  }

  // Clear log file
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

// Create singleton instance
export const logger = new Logger();