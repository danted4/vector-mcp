# Developer Guide for vector-mcp

## Build/Test Commands
- `yarn start` - Start Express server with web UI on port 3000
- `yarn run mcp` - Start MCP server on stdio for Claude integration
- `yarn run setup` - Run setup script
- `docker-compose up -d` - Start MongoDB container
- `curl http://localhost:3000/health` - Test server health
- No specific test suite, lint, or build commands configured

## Code Style & Conventions

### Module System & Imports
- Uses ES6 modules (`"type": "module"` in package.json)
- Import statements MUST include `.js` extensions for local files
- Named imports for utilities: `import { logger } from './utils/logger/logger.js'`
- Default exports for main classes: `export class ClassName`

### Naming & Structure
- PascalCase for classes: `MongoVectorStore`, `FileIndexer`, `OllamaEmbedding`
- camelCase for variables and functions: `vectorStore`, `embeddingProvider`
- File organization: utils in `utils/` subdirectories by functionality
- Class files use descriptive names matching class: `mongovs.js` for `MongoVectorStore`

### Error Handling & Logging
- Try-catch blocks for all async operations with graceful fallbacks
- Use singleton logger from `utils/logger/logger.js` with emoji prefixes
- Methods: `logger.info()`, `logger.success()`, `logger.error()`, `logger.warn()`
- Console.error for MCP server stderr output (doesn't interfere with stdio)