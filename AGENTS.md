# Developer Guide for vector-mcp

## Build/Test Commands
- `npm start` - Start Express server with web UI on port 3000
- `npm run mcp` - Start MCP server on stdio for Claude integration
- `docker-compose up -d` - Start MongoDB container
- `curl http://localhost:3000/health` - Test server health
- No specific build or lint commands configured

## Development Setup
1. Start MongoDB: `docker-compose up -d`
2. Ensure Ollama is running with llama2 model
3. Start web server: `npm start` (UI at http://localhost:3000)
4. For MCP: `npm run mcp` (stdio protocol for Claude)

## Code Style & Conventions

### Module System
- Uses ES6 modules (`"type": "module"` in package.json)
- Import statements with `.js` extensions required
- Default exports for classes: `export class ClassName`

### Environment Variables
- `MONGODB_URI` - MongoDB connection string
- `OLLAMA_HOST` - Ollama server URL
- `OLLAMA_MODEL` - Embedding model (default: llama2)
- `PORT` - Web server port (default: 3000)

### File Structure
- `index.js` - Express server with web UI and API
- `mcp-server.js` - MCP protocol server for Claude
- `MongoVectorStore.js`, `FileIndexer.js`, `OllamaEmbedding.js` - Core classes
- `public/index.html` - Web interface

### Coding Patterns
- Constructor dependency injection pattern
- Async/await for all async operations
- ES6 class syntax with constructor parameters
- Graceful fallbacks (dummy embeddings when Ollama fails)
- Environment variable configuration with defaults