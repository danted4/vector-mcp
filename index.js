// ==========================================
// Vector MCP Server - Main Application
// ==========================================

import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { OllamaEmbedding } from './utils/vector-store/embeddings.js';
import { MongoVectorStore } from './utils/vector-store/mongovs.js';
import { FileIndexer } from './utils/indexer/xr.js';
import { JobManager } from './utils/jobs/manager.js';
import { logger } from './utils/logger/logger.js';
import fs from 'fs';

// ES6 module compatibility setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express app configuration
const app = express();
app.use(bodyParser.json({ limit: '50mb' })); // Large limit for base64 file uploads
app.use(express.static(path.join(__dirname, 'public')));

// Database and service configuration
const mongoUri = process.env.MONGODB_URI || 'mongodb://root:examplepassword@localhost:27017';
const mongoClient = new MongoClient(mongoUri);

// Global service instances (initialized in init())
let vectorStore;
let embeddingProvider;
let fileIndexer;
let jobManager;

/**
 * Initializes all services and database connections
 * Sets up MongoDB indexes and tests external service connections
 * @returns {Promise<void>}
 * @throws {Error} If initialization fails
 */
async function init() {
  try {
    logger.info('Starting Vector MCP server initialization');
    
    // Connect to MongoDB and setup database
    logger.info('Connecting to MongoDB...');
    await mongoClient.connect();
    const db = mongoClient.db('code_context');
    const collection = db.collection('documents');

    // Create performance indexes for vector operations
    await collection.createIndex({ embedding: 1 }); // For similarity searches
    await collection.createIndex({ projectId: 1 }); // For project filtering
    await collection.createIndex({ filePath: 1 }); // For file lookups

    // Initialize service instances
    vectorStore = new MongoVectorStore(collection, db);
    embeddingProvider = new OllamaEmbedding(process.env.OLLAMA_MODEL || 'llama2');
    jobManager = new JobManager();
    fileIndexer = new FileIndexer(embeddingProvider, vectorStore, jobManager);
    
    logger.success('MongoDB connected and indexes created');
    
    // Test Ollama embedding service availability
    try {
      logger.info('Testing Ollama connection...');
      await embeddingProvider.getEmbedding('test');
      logger.success('Ollama connection successful');
    } catch (error) {
      logger.warn(`Ollama connection failed: ${error.message}`);
      logger.warn('Make sure Ollama is running with: ollama serve');
    }
    
  } catch (error) {
    logger.error('Initialization failed', { error: error.message });
    throw error;
  }
}

// ==========================================
// Web UI Routes
// ==========================================

/**
 * Serves the main web UI interface
 * @route GET /
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// MCP Protocol Routes
// ==========================================

/**
 * MCP endpoint for semantic code search queries
 * Handles embedding generation and vector similarity search
 * @route POST /mcp/context
 * @param {Object} req.body - Request body
 * @param {string} req.body.query - Search query text
 * @param {number} [req.body.topK=3] - Number of results to return
 * @param {string} [req.body.projectId] - Optional project filter
 */
app.post('/mcp/context', async (req, res) => {
  const { query, topK, projectId } = req.body;

  if (!embeddingProvider || !vectorStore) {
    return res.status(500).json({ error: 'Server not initialized' });
  }

  try {
    console.log(`Context query: "${query}" (project: ${projectId || 'all'}, limit: ${topK || 3})`);
    
    // Generate embedding vector for the search query
    const queryEmbedding = await embeddingProvider.getEmbedding(query);

    // Search for most similar code chunks
    const results = await vectorStore.search(queryEmbedding, topK || 3, projectId);

    res.json({ results });
  } catch (error) {
    console.error('Error in context request:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Project Management API Routes
// ==========================================

/**
 * Creates a new project index asynchronously
 * Starts a background job and returns immediately with job ID
 * @route POST /api/projects
 * @param {Object} req.body - Request body
 * @param {string} req.body.projectId - Unique project identifier
 * @param {string} req.body.directoryPath - Directory to index
 * @param {string[]} [req.body.excludePatterns] - Patterns to exclude from indexing
 */
app.post('/api/projects', async (req, res) => {
  const { projectId, directoryPath, excludePatterns = [] } = req.body;

  if (!projectId || !directoryPath) {
    return res.status(400).json({ error: 'projectId and directoryPath are required' });
  }

  try {
    // Create async job for indexing
    const job = jobManager.createJob('index', projectId, { directoryPath, excludePatterns });
    
    // Start the indexing job in background
    jobManager.runIndexJob(job.id, fileIndexer, directoryPath, projectId, excludePatterns, false)
      .catch(error => {
        logger.error(`Job ${job.id} failed: ${error.message}`, { jobId: job.id, projectId });
      });

    // Return immediately with job tracking information
    res.json({ 
      jobId: job.id,
      status: 'started',
      message: 'Indexing job started. Use /api/jobs/{jobId} to check progress.'
    });
  } catch (error) {
    logger.error('Error starting index job', { error: error.message, projectId });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Updates an existing project with delta indexing
 * Only processes files that have changed since last indexing
 * @route POST /api/projects/:projectId/update
 * @param {string} req.params.projectId - Project ID to update
 * @param {Object} req.body - Request body
 * @param {string} req.body.directoryPath - Directory to scan for changes
 * @param {string[]} [req.body.excludePatterns] - Patterns to exclude
 */
app.post('/api/projects/:projectId/update', async (req, res) => {
  const { projectId } = req.params;
  const { directoryPath, excludePatterns = [] } = req.body;

  if (!directoryPath) {
    return res.status(400).json({ error: 'directoryPath is required' });
  }

  try {
    // Create delta update job
    const job = jobManager.createJob('update', projectId, { directoryPath, excludePatterns });
    
    // Start delta indexing job (deltaOnly = true)
    jobManager.runIndexJob(job.id, fileIndexer, directoryPath, projectId, excludePatterns, true)
      .catch(error => {
        logger.error(`Job ${job.id} failed: ${error.message}`, { jobId: job.id, projectId });
      });

    // Return job tracking information
    res.json({ 
      jobId: job.id,
      status: 'started',
      message: 'Delta update job started. Use /api/jobs/{jobId} to check progress.'
    });
  } catch (error) {
    logger.error('Error starting update job', { error: error.message, projectId });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Creates a test index of the current server directory
 * Useful for testing the indexing system without external paths
 * @route POST /api/test-current-dir
 */
app.post('/api/test-current-dir', async (req, res) => {
  try {
    const testProjectId = 'test-' + Date.now();
    const job = jobManager.createJob('index', testProjectId, { 
      directoryPath: process.cwd(),
      excludePatterns: ['public/**'] // Exclude public assets
    });
    
    // Start test indexing job
    jobManager.runIndexJob(job.id, fileIndexer, process.cwd(), testProjectId, ['public/**'], false)
      .catch(error => {
        logger.error(`Job ${job.id} failed: ${error.message}`, { jobId: job.id, projectId: testProjectId });
      });

    res.json({ 
      jobId: job.id,
      projectId: testProjectId,
      status: 'started',
      message: 'Test indexing job started. Use /api/jobs/{jobId} to check progress.'
    });
  } catch (error) {
    logger.error('Error starting test job', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Retrieves all available projects from the database
 * @route GET /api/projects
 */
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await vectorStore.getProjects();
    res.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Deletes a project and all its associated documents
 * @route DELETE /api/projects/:projectId
 * @param {string} req.params.projectId - Project ID to delete
 */
app.delete('/api/projects/:projectId', async (req, res) => {
  const { projectId } = req.params;
  
  try {
    const deletedCount = await vectorStore.deleteProject(projectId);
    res.json({ deletedCount });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Gets detailed statistics for a specific project
 * @route GET /api/projects/:projectId/stats
 * @param {string} req.params.projectId - Project ID to get stats for
 */
app.get('/api/projects/:projectId/stats', async (req, res) => {
  const { projectId } = req.params;
  
  try {
    const stats = await vectorStore.getProjectStats(projectId);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching project stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Gets stored metadata for a project (directory path, exclude patterns, etc.)
 * @route GET /api/projects/:projectId/metadata
 * @param {string} req.params.projectId - Project ID to get metadata for
 */
app.get('/api/projects/:projectId/metadata', async (req, res) => {
  const { projectId } = req.params;
  
  try {
    const metadata = await vectorStore.getProjectMetadata(projectId);
    if (!metadata) {
      return res.status(404).json({ error: 'Project metadata not found' });
    }
    res.json(metadata);
  } catch (error) {
    console.error('Error fetching project metadata:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Job Management API Routes
// ==========================================

/**
 * Gets the status and progress of a specific job
 * @route GET /api/jobs/:jobId
 * @param {string} req.params.jobId - Job ID to query
 */
app.get('/api/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  
  try {
    const job = jobManager.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json(job);
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Lists all jobs (completed, running, and pending)
 * @route GET /api/jobs
 */
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = jobManager.getAllJobs();
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Lists only currently active jobs (running or pending)
 * @route GET /api/jobs/active
 */
app.get('/api/jobs/active', async (req, res) => {
  try {
    const activeJobs = jobManager.getActiveJobs();
    res.json(activeJobs);
  } catch (error) {
    logger.error('Error fetching active jobs', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Logging API Routes
// ==========================================

/**
 * Clears the server log file
 * @route POST /api/logs/clear
 */
app.post('/api/logs/clear', async (req, res) => {
  try {
    const success = logger.clear();
    if (success) {
      logger.info('Log clear request completed - stream will continue monitoring');
      res.json({ success: true, message: 'Server logs cleared successfully' });
    } else {
      res.status(500).json({ error: 'Failed to clear logs' });
    }
  } catch (error) {
    logger.error('Error clearing logs', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Server-Sent Events endpoint for real-time log streaming
 * Watches the server log file and streams new entries to connected clients
 * @route GET /api/logs/stream
 */
app.get('/api/logs/stream', async (req, res) => {
  // Setup SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send recent logs as historical context (last 50 lines)
  try {
    const recentLogs = await logger.getRecentLogs(50);
    recentLogs.forEach(logLine => {
      res.write(`data: ${JSON.stringify({
        type: 'historical',
        message: logLine,
        timestamp: new Date().toISOString()
      })}\n\n`);
    });
  } catch (error) {
    logger.error('Error reading recent logs', { error: error.message });
  }

  // Send connection confirmation
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    message: '📡 Connected to server log stream',
    timestamp: new Date().toISOString()
  })}\n\n`);

  // Setup file watching for real-time streaming
  const logFile = logger.logFile;
  let lastPosition = 0;
  let fileCleared = false;
  
  // Get initial file position
  try {
    const stats = await fs.promises.stat(logFile);
    lastPosition = stats.size;
  } catch (error) {
    // File doesn't exist yet, start from beginning
    lastPosition = 0;
  }

  // Use polling-based file watching for cross-platform compatibility
  const watchInterval = 1000; // Check every second
  const watcher = setInterval(async () => {
    try {
      const stats = await fs.promises.stat(logFile);
      
      // Detect if file was cleared (size became smaller)
      if (stats.size < lastPosition) {
        fileCleared = true;
        lastPosition = 0;
        res.write(`data: ${JSON.stringify({
          type: 'cleared',
          message: '🧹 Log file cleared - continuing to monitor new logs',
          timestamp: new Date().toISOString()
        })}\n\n`);
      }
      
      // Check for new content
      if (stats.size > lastPosition) {
        // File has grown, read new content
        const stream = fs.createReadStream(logFile, { 
          start: lastPosition, 
          encoding: 'utf8' 
        });
        
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer
          
          lines.forEach(line => {
            if (line.trim()) {
              res.write(`data: ${JSON.stringify({
                type: 'live',
                message: line,
                timestamp: new Date().toISOString()
              })}\n\n`);
            }
          });
        });
        
        stream.on('end', () => {
          lastPosition = stats.size;
        });
        
        stream.on('error', (error) => {
          // Handle read errors gracefully
          if (error.code !== 'ENOENT') {
            logger.error('Error reading log file stream', { error: error.message });
          }
        });
      }
    } catch (error) {
      // Handle file access errors
      if (error.code === 'ENOENT') {
        // File was deleted, reset position and wait for recreation
        if (lastPosition > 0) {
          lastPosition = 0;
          res.write(`data: ${JSON.stringify({
            type: 'file_missing',
            message: '⚠️ Log file not found - waiting for new logs',
            timestamp: new Date().toISOString()
          })}\n\n`);
        }
      } else {
        logger.error('Error watching log file', { error: error.message });
      }
    }
  }, watchInterval);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(watcher);
  });

  req.on('aborted', () => {
    clearInterval(watcher);
  });
});

// ==========================================
// Health Check Route
// ==========================================

/**
 * Health check endpoint for monitoring service status
 * Tests connectivity to MongoDB and Ollama services
 * @route GET /health
 */
app.get('/health', async (req, res) => {
  try {
    // Test MongoDB connection
    await mongoClient.db('admin').command({ ping: 1 });
    
    // Test Ollama embedding service
    await embeddingProvider.getEmbedding('health check');
    
    res.json({ 
      status: 'healthy', 
      mongodb: 'connected',
      ollama: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ==========================================
// Server Configuration and Startup
// ==========================================

const PORT = process.env.PORT || 3000;

/**
 * Handles graceful shutdown on SIGINT (Ctrl+C)
 * Closes database connections before exiting
 */
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await mongoClient.close();
  process.exit(0);
});

/**
 * Application startup sequence
 * Initializes services and starts the Express server
 */
init().then(() => {
  app.listen(PORT, () => {
    logger.success(`Vector MCP server running on http://localhost:${PORT}`);
    logger.info(`Web UI available at http://localhost:${PORT}`);
    logger.info(`MCP endpoint at http://localhost:${PORT}/mcp/context`);
    logger.info(`Health check at http://localhost:${PORT}/health`);
    logger.info('Real-time log streaming available at /api/logs/stream');
    
    // Schedule cleanup of old completed jobs every hour
    setInterval(() => {
      jobManager.cleanupOldJobs();
    }, 60 * 60 * 1000);
  });
}).catch(err => {
  logger.error('Failed to initialize server', { error: err.message });
  process.exit(1);
});