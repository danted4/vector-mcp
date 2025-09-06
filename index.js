import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { OllamaEmbedding } from './OllamaEmbedding.js';
import { MongoVectorStore } from './MongoVectorStore.js';
import { FileIndexer } from './FileIndexer.js';
import { JobManager } from './JobManager.js';
import { logger } from './Logger.js';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const mongoUri = process.env.MONGODB_URI || 'mongodb://root:examplepassword@localhost:27017';
const mongoClient = new MongoClient(mongoUri);

let vectorStore;
let embeddingProvider;
let fileIndexer;
let jobManager;

async function init() {
  try {
    logger.info('Starting Vector MCP server initialization');
    logger.info('Connecting to MongoDB...');
    await mongoClient.connect();
    const db = mongoClient.db('code_context');
    const collection = db.collection('documents');

    // Create indexes
    await collection.createIndex({ embedding: 1 });
    await collection.createIndex({ projectId: 1 });
    await collection.createIndex({ filePath: 1 });

    vectorStore = new MongoVectorStore(collection, db);
    embeddingProvider = new OllamaEmbedding(process.env.OLLAMA_MODEL || 'llama2');
    jobManager = new JobManager();
    fileIndexer = new FileIndexer(embeddingProvider, vectorStore, jobManager);
    
    logger.success('MongoDB connected and indexes created');
    
    // Test Ollama connection
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

// Serve the web UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// MCP endpoint to serve context queries
app.post('/mcp/context', async (req, res) => {
  const { query, topK, projectId } = req.body;

  if (!embeddingProvider || !vectorStore) {
    return res.status(500).json({ error: 'Server not initialized' });
  }

  try {
    console.log(`Context query: "${query}" (project: ${projectId || 'all'}, limit: ${topK || 3})`);
    
    // Get query embedding
    const queryEmbedding = await embeddingProvider.getEmbedding(query);

    // Search for top relevant docs
    const results = await vectorStore.search(queryEmbedding, topK || 3, projectId);

    res.json({ results });
  } catch (error) {
    console.error('Error in context request:', error);
    res.status(500).json({ error: error.message });
  }
});

// API to create new project index (async with job)
app.post('/api/projects', async (req, res) => {
  const { projectId, directoryPath, excludePatterns = [] } = req.body;

  if (!projectId || !directoryPath) {
    return res.status(400).json({ error: 'projectId and directoryPath are required' });
  }

  try {
    const job = jobManager.createJob('index', projectId, { directoryPath, excludePatterns });
    
    // Start the job asynchronously
    jobManager.runIndexJob(job.id, fileIndexer, directoryPath, projectId, excludePatterns, false)
      .catch(error => {
        logger.error(`Job ${job.id} failed: ${error.message}`, { jobId: job.id, projectId });
      });

    // Return immediately with job ID
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

// API to update existing project index (delta only, async with job)
app.post('/api/projects/:projectId/update', async (req, res) => {
  const { projectId } = req.params;
  const { directoryPath, excludePatterns = [] } = req.body;

  if (!directoryPath) {
    return res.status(400).json({ error: 'directoryPath is required' });
  }

  try {
    const job = jobManager.createJob('update', projectId, { directoryPath, excludePatterns });
    
    // Start the job asynchronously
    jobManager.runIndexJob(job.id, fileIndexer, directoryPath, projectId, excludePatterns, true)
      .catch(error => {
        logger.error(`Job ${job.id} failed: ${error.message}`, { jobId: job.id, projectId });
      });

    // Return immediately with job ID
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

// API to test indexing current directory (async)
app.post('/api/test-current-dir', async (req, res) => {
  try {
    const testProjectId = 'test-' + Date.now();
    const job = jobManager.createJob('index', testProjectId, { 
      directoryPath: process.cwd(),
      excludePatterns: ['public/**']
    });
    
    // Start the job asynchronously
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

// API to get job status
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

// API to list all jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = jobManager.getAllJobs();
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ error: error.message });
  }
});

// API to get active jobs
app.get('/api/jobs/active', async (req, res) => {
  try {
    const activeJobs = jobManager.getActiveJobs();
    res.json(activeJobs);
  } catch (error) {
    logger.error('Error fetching active jobs', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// API to clear server logs
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

// API to list all projects
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await vectorStore.getProjects();
    res.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: error.message });
  }
});

// API to delete a project
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

// API to get project statistics
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

// API to get project metadata
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

// Server-Sent Events endpoint for real-time log streaming from server.log
app.get('/api/logs/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send recent logs first (last 50 lines)
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

  // Watch server.log file for changes
  const logFile = logger.logFile;
  let lastPosition = 0;
  let fileCleared = false;
  
  try {
    const stats = await fs.promises.stat(logFile);
    lastPosition = stats.size;
  } catch (error) {
    // File doesn't exist yet, start from beginning
    lastPosition = 0;
  }

  // Use fs.watchFile for cross-platform compatibility
  const watchInterval = 1000; // Check every second
  const watcher = setInterval(async () => {
    try {
      const stats = await fs.promises.stat(logFile);
      
      // Check if file was cleared (size became smaller)
      if (stats.size < lastPosition) {
        fileCleared = true;
        lastPosition = 0;
        res.write(`data: ${JSON.stringify({
          type: 'cleared',
          message: '🧹 Log file cleared - continuing to monitor new logs',
          timestamp: new Date().toISOString()
        })}\n\n`);
      }
      
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
      // File might not exist or be accessible
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

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check MongoDB connection
    await mongoClient.db('admin').command({ ping: 1 });
    
    // Check Ollama connection
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

const PORT = process.env.PORT || 3000;

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await mongoClient.close();
  process.exit(0);
});

init().then(() => {
  app.listen(PORT, () => {
    logger.success(`Vector MCP server running on http://localhost:${PORT}`);
    logger.info(`Web UI available at http://localhost:${PORT}`);
    logger.info(`MCP endpoint at http://localhost:${PORT}/mcp/context`);
    logger.info(`Health check at http://localhost:${PORT}/health`);
    logger.info('Real-time log streaming available at /api/logs/stream');
    
    // Cleanup old jobs every hour
    setInterval(() => {
      jobManager.cleanupOldJobs();
    }, 60 * 60 * 1000);
  });
}).catch(err => {
  logger.error('Failed to initialize server', { error: err.message });
  process.exit(1);
});