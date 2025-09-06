# Vector MCP - Code Context Server

A Model Context Protocol (MCP) server for Claude Code that provides semantic search across codebases using MongoDB and Ollama embeddings.

## Features

- 🔍 **Semantic Code Search** - Search your codebase using natural language queries
- 📁 **Project Management** - Index multiple projects with isolated namespaces
- 🔄 **Delta Indexing** - Only re-index files that have changed, saving time and resources
- 🎨 **Web UI** - Easy-to-use interface for managing indexes and testing searches
- 🔧 **MCP Integration** - Works seamlessly with Claude Code/OpenCode
- 🐳 **Docker Ready** - Simple setup with Docker Compose for mongodb (vector store)
- 🦙 **Ollama Support** - Local embeddings using Ollama with llama2 model

## Quick Start

### 🐳 Docker Setup (Recommended)

### Prerequisites (host machine requirements)
#### 1. 🔧 Docker Setup - https://www.docker.com/ (Optional if - you want to run mongo on host in which case having mongo on host becomes the prerequisite)
#### 2. 🔧 Ollama - https://ollama.com/download (Optional if - you want to use paid openAI or API keys for indexing, for free we will use llama2 for indexing)


1. **Clone**

   ```bash
   # Clone and enter the project directory
   git clone <repository-url>
   cd vector-mcp

2. **Start MongoDB with Docker:**
   ```bash
   ./setup.sh
   ```

3. **Install and start Ollama:**
   ```bash
   # Install Ollama (macOS)
   brew install ollama
   
   # Start Ollama service
   ollama serve
   
   # Pull the llama2 model
   ollama pull llama2
   ```

4. **Install dependencies:**
   ```bash
   npm install
   ```

5. **Start the web UI server:**
   ```bash
   npm start
   ```
   Visit http://localhost:3000 to access the web interface.

6. **For Claude Code integration, start the MCP server:**
   ```bash
   npm run mcp
   ```

## Usage

### Web Interface

1. Open http://localhost:3000
2. Create a new index by providing:
   - Project ID (unique identifier)
   - Directory path to index
   - Optional exclude patterns
3. Use the search interface to test queries
4. Manage existing projects (view stats, delete)

### Claude Code Integration

Add this MCP server to your Claude Code configuration:

```json
{
  "mcpServers": {
    "vector-mcp": {
      "command": "node",
      "args": ["mcp-server.js"],
      "cwd": "/path/to/vector-mcp",
      "env": {
        "MONGODB_URI": "mongodb://root:examplepassword@localhost:27017",
        "OLLAMA_HOST": "http://localhost:11434",
        "OLLAMA_MODEL": "llama2"
      }
    }
  }
}
```

### Available MCP Tools

- `search_code` - Search through indexed code using semantic similarity
- `index_codebase` - Index a new project directory
- `update_project` - Update an existing project with delta changes only
- `list_projects` - List all indexed projects
- `delete_project` - Delete a project and its data
- `get_project_stats` - Get detailed project statistics

## Delta Indexing

The project supports intelligent delta indexing that only processes files that have changed since the last index update. This provides significant performance benefits for large codebases.

### How Delta Indexing Works

1. **File Tracking** - Each indexed file stores metadata including:
   - File size, modification time, and content hash
   - File path and chunk information

2. **Change Detection** - During delta updates:
   - Compares current file hash with stored hash
   - Checks file modification time and size
   - Only processes files that have actually changed

3. **Efficient Updates** - Delta indexing will:
   - ✅ **Skip** unchanged files (fastest)
   - 🔄 **Update** modified files by removing old chunks and adding new ones
   - ➕ **Add** newly created files
   - 🗑️ **Remove** chunks for deleted files

### Using Delta Indexing

**Web UI:** Click the orange "Update" button next to any project to run a delta update.

**MCP Tool:** Use the `update_project` tool with your project ID and directory path.

**API:** POST to `/api/projects/{projectId}/update` with directory path and exclude patterns.

### Performance Benefits

- **Large codebases**: Instead of re-indexing 1000+ files, typically only 1-10 files change
- **Development workflow**: Quick updates during active development
- **CI/CD integration**: Efficient incremental indexing in automated pipelines

Example delta update results:
```
Delta stats: 847 skipped, 3 updated, 1 added, 0 deleted
Files processed: 4/851 files
Time saved: ~95% compared to full re-index
```

## Asynchronous Job System

All indexing operations now run asynchronously with real-time progress monitoring:

### Features

- **Immediate Response**: APIs return immediately with a job ID
- **Progress Monitoring**: Real-time status updates every 3-5 seconds
- **Job History**: View recent and active jobs in the web UI
- **Non-blocking**: Browser doesn't freeze during long indexing operations
- **Detailed Logs**: Per-job logging and statistics

### API Changes

**Before (blocking):**
```javascript
POST /api/projects -> waits for completion, returns final result
```

**After (async):**
```javascript
POST /api/projects -> returns immediately with jobId
GET /api/jobs/{jobId} -> poll for status and progress
GET /api/jobs -> list all jobs
```

### Job Statuses

- `pending` - Job created, waiting to start
- `running` - Currently processing files with real-time progress tracking
- `completed` - Successfully finished
- `failed` - Error occurred during processing

### Progress Tracking

Jobs now show **data-driven progress percentages**:

- **5-15%**: Directory scanning and metadata loading
- **15-85%**: File processing (incremental based on files processed)  
- **85-95%**: Database operations and cleanup
- **95-100%**: Final metadata saving and completion

**Progress Display:**
- **Visual progress bars** in job cards
- **Percentage indicators** for running jobs
- **File counters**: "45/192 files processed"
- **Fallback to status-only** if progress unavailable

### Web UI Improvements

- **Real-time Progress**: See live updates as files are processed
- **Job Dashboard**: Monitor active and recent jobs
- **Auto-refresh**: Jobs list updates every 10 seconds
- **Progress Indicators**: Visual feedback during operations
- **Live Log Streaming**: Real-time logs via Server-Sent Events
- **Modal Forms**: Professional UI instead of browser alerts
- **Project Memory**: Stores directory paths and settings for easy updates

## Real-time Features

### Live Log Streaming
- **File-based Logging**: All logs written to `server.log` file
- **Server-Sent Events**: Real-time streaming from actual log file
- **Historical Logs**: Shows recent log entries on connection
- **Automatic Connection**: Starts streaming immediately on page load
- **Auto-reconnection**: Handles connection drops gracefully
- **Persistent Storage**: Logs survive server restarts

### Project Metadata Storage
- **Path Memory**: Directory paths stored in database after first index
- **Settings Persistence**: Exclude patterns remembered per project
- **Smart Defaults**: Update forms pre-filled with previous settings
- **Backward Compatible**: Works with existing projects

### Enhanced Forms
- **Modal Interface**: Clean, professional forms instead of browser prompts
- **Pre-filled Data**: Forms populate with existing project settings
- **Validation**: Client-side validation before submission
- **Contextual Help**: Helpful placeholders and tips

## API Enhancements

### New Endpoints
- `GET /api/logs/stream` - Server-Sent Events for real-time logs
- `GET /api/projects/{id}/metadata` - Get stored project settings
- `GET /api/jobs/active` - Get only currently running jobs

### Database Schema
Projects now store metadata in `project_metadata` collection:
```json
{
  "projectId": "my-project",
  "directoryPath": "/path/to/project", 
  "excludePatterns": ["*.log", "node_modules/**"],
  "createdAt": "2025-01-06T...",
  "lastIndexed": "2025-01-06T...",
  "updatedAt": "2025-01-06T..."
}
```

## Configuration

### Docker Environment Variables

The Docker setup uses the following environment variables (configured in `docker-compose.yml`):

```env
MONGODB_URI=mongodb://root:examplepassword@mongodb:27017
OLLAMA_HOST=http://ollama:11434
OLLAMA_MODEL=llama2
PORT=3000
NODE_ENV=production
```

## Project Structure

- `index.js` - Web server with UI and API endpoints
- `mcp-server.js` - MCP protocol server for Claude integration
- `MongoVectorStore.js` - MongoDB vector storage implementation
- `OllamaEmbedding.js` - Ollama embedding provider
- `FileIndexer.js` - Code indexing and chunking logic
- `public/index.html` - Web interface

## Docker Commands

### Service Management
```bash
# Start all services
docker-compose up -d

# Stop all services  
docker-compose down

# View all service logs
docker-compose logs -f
```

### Service Health Checks
```bash
# Check service status
docker-compose ps

# Check individual service health
curl http://localhost:3000/health      # Vector MCP
curl http://localhost:11434/api/tags   # Ollama
```

### Data Management
```bash
# Backup MongoDB data
docker-compose exec mongodb mongodump --uri="mongodb://root:examplepassword@localhost:27017"

# Clear all data (destructive!)
docker-compose down -v
```

## Troubleshooting

### Docker Issues
**Services won't start:**
```bash
# Check Docker is running
docker info
```

### Service-Specific Issues
**MongoDB Connection:**
- Ensure MongoDB container is healthy: `docker-compose ps`
- Check connection from app container: `docker-compose exec vector-mcp curl -f mongodb:27017`

**Performance:**
- Large codebases may take time to index
- Monitor container resources: `docker stats`
- Consider adjusting chunk size in `FileIndexer.js`

## Production Deployment

### Docker Compose Production
```bash
# Use production compose file
docker-compose -f docker-compose.yml up -d

# Enable log rotation
docker-compose exec vector-mcp logrotate /etc/logrotate.conf
```

## License

MIT