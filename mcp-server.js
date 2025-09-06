#!/usr/bin/env node

// ==========================================
// Vector MCP Server - Model Context Protocol Interface
// ==========================================
// This server provides MCP tools for semantic code search and project management
// for use with Claude Code and other MCP-compatible clients.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { MongoClient } from 'mongodb';
import { OllamaEmbedding } from './utils/vector-store/embeddings.js';
import { MongoVectorStore } from './utils/vector-store/mongovs.js';
import { FileIndexer } from './utils/indexer/xr.js';

// Database configuration
const mongoUri = process.env.MONGODB_URI || 'mongodb://root:examplepassword@localhost:27017';
const mongoClient = new MongoClient(mongoUri);

// Default project configuration from environment
const DEFAULT_PROJECT_ID = process.env.DEFAULT_PROJECT_ID;
const DEFAULT_DIRECTORY_PATH = process.env.DEFAULT_DIRECTORY_PATH;

// Global service instances (initialized in initMCP())
let vectorStore;
let embeddingProvider;
let fileIndexer;

/**
 * Initializes the MCP server with database connections and service instances
 * Sets up MongoDB indexes and creates service objects for vector operations
 * @returns {Promise<void>}
 * @throws {Error} If initialization fails
 */
async function initMCP() {
  try {
    await mongoClient.connect();
    const db = mongoClient.db('code_context');
    const collection = db.collection('documents');

    // Create performance indexes for vector operations
    await collection.createIndex({ embedding: 1 }); // Vector similarity searches
    await collection.createIndex({ projectId: 1 }); // Project-scoped queries
    await collection.createIndex({ filePath: 1 }); // File-based lookups

    // Initialize service instances
    vectorStore = new MongoVectorStore(collection, db);
    embeddingProvider = new OllamaEmbedding(process.env.OLLAMA_MODEL || 'llama2');
    fileIndexer = new FileIndexer(embeddingProvider, vectorStore);
    
    console.error('✅ MCP Vector server initialized');
  } catch (error) {
    console.error('❌ MCP initialization failed:', error);
    throw error;
  }
}

/**
 * Main MCP server class that handles tool registration and request routing
 * Provides semantic code search and project management capabilities via MCP protocol
 */
class VectorMCPServer {
  /**
   * Creates a new VectorMCPServer instance
   * Initializes the MCP server and sets up request handlers
   */
  constructor() {
    this.server = new Server(
      {
        name: 'vector-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Sets up all MCP request handlers for tools, resources, and tool execution
   * Defines the available tools and their schemas for client discovery
   */
  setupHandlers() {
    // Tool discovery handler - returns available tools and their schemas
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'search_code',
            description: 'Search through indexed code using semantic similarity',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Natural language query to search for in code'
                },
                projectId: {
                  type: 'string',
                  description: 'Project ID to search within (uses DEFAULT_PROJECT_ID env var if not provided)'
                },
                topK: {
                  type: 'number',
                  description: 'Number of results to return (default: 5)',
                  default: 5
                }
              },
              required: []
            }
          },
          {
            name: 'list_projects',
            description: 'List all indexed projects with statistics',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'delete_project',
            description: 'Delete a project and all its indexed data',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: {
                  type: 'string',
                  description: 'Project ID to delete'
                }
              },
              required: ['projectId']
            }
          },
          {
            name: 'get_project_stats',
            description: 'Get detailed statistics for a project',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: {
                  type: 'string',
                  description: 'Project ID to get stats for'
                }
              },
              required: ['projectId']
            }
          },
          {
            name: 'update_project',
            description: 'Update an existing project with delta changes only',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: {
                  type: 'string',
                  description: 'Project ID to update (uses DEFAULT_PROJECT_ID env var if not provided)'
                },
                directoryPath: {
                  type: 'string',
                  description: 'Path to the directory to scan for changes (uses DEFAULT_DIRECTORY_PATH env var if not provided)'
                },
                excludePatterns: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Additional patterns to exclude (beyond defaults)',
                  default: []
                }
              },
              required: []
            }
          }
        ]
      };
    });

    // Tool execution handler - routes tool calls to appropriate methods
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_code':
            return await this.handleSearchCode(args);
          case 'index_codebase':
            return await this.handleIndexCodebase(args);
          case 'list_projects':
            return await this.handleListProjects(args);
          case 'delete_project':
            return await this.handleDeleteProject(args);
          case 'get_project_stats':
            return await this.handleGetProjectStats(args);
          case 'update_project':
            return await this.handleUpdateProject(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ]
        };
      }
    });

    // Resource discovery handler - lists available project resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const projects = await vectorStore.getProjects();
      return {
        resources: projects.map(project => ({
          uri: `vector://project/${project.projectId}`,
          name: `Project: ${project.projectId}`,
          description: `Indexed project with ${project.documentCount} documents`,
          mimeType: 'application/json'
        }))
      };
    });

    // Resource reading handler - provides project data when requested
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const url = new URL(request.params.uri);
      
      if (url.protocol === 'vector:' && url.pathname.startsWith('/project/')) {
        const projectId = url.pathname.split('/')[2];
        const stats = await vectorStore.getProjectStats(projectId);
        
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: JSON.stringify(stats, null, 2)
            }
          ]
        };
      }
      
      throw new Error(`Unknown resource: ${request.params.uri}`);
    });
  }

  /**
   * Handles semantic code search requests
   * Generates embeddings for the query and performs vector similarity search
   * @param {Object} args - Search arguments
   * @param {string} args.query - Natural language search query
   * @param {string} [args.projectId] - Optional project filter
   * @param {number} [args.topK=5] - Number of results to return
   * @returns {Promise<Object>} Formatted search results
   */
   async handleSearchCode(args) {
    const { query, projectId = DEFAULT_PROJECT_ID, topK = 5 } = args;
    
    if (!query) {
      throw new Error('Query is required');
    }

    console.error(`Searching for: "${query}" in project: ${projectId || 'all'}`);
    
    // Generate embedding vector for the search query
    const queryEmbedding = await embeddingProvider.getEmbedding(query);
    
    // Perform vector similarity search
    const results = await vectorStore.search(queryEmbedding, topK, projectId);

    // Format results with markdown for better readability
    const formatted = results.map((result, index) => {
      return `**Result ${index + 1}** (Score: ${result.score.toFixed(4)})
**File:** ${result.filePath}
**Project:** ${result.projectId}

\`\`\`${result.filePath.split('.').pop()}
${result.content}
\`\`\`

---`;
    }).join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} relevant code snippets:\n\n${formatted}`
        }
      ]
    };
  }

  /**
   * Handles codebase indexing requests
   * Processes files in the specified directory and creates vector embeddings
   * @param {Object} args - Indexing arguments
   * @param {string} args.projectId - Unique project identifier
   * @param {string} args.directoryPath - Directory to index
   * @param {string[]} [args.excludePatterns] - Additional exclude patterns
   * @returns {Promise<Object>} Indexing results summary
   */
   async handleIndexCodebase(args) {
    const { 
      projectId = DEFAULT_PROJECT_ID, 
      directoryPath = DEFAULT_DIRECTORY_PATH, 
      excludePatterns = [] 
    } = args;

    if (!projectId) {
      throw new Error('Project ID is required (provide as argument or set DEFAULT_PROJECT_ID environment variable)');
    }

    if (!directoryPath) {
      throw new Error('Directory path is required (provide as argument or set DEFAULT_DIRECTORY_PATH environment variable)');
    }

    console.error(`Indexing codebase: ${projectId} from ${directoryPath}`);
    
    // Perform full directory indexing
    const result = await fileIndexer.indexDirectory(directoryPath, projectId, excludePatterns);
    
    return {
      content: [
        {
          type: 'text',
          text: `✅ Successfully indexed project "${projectId}"
📁 Directory: ${directoryPath}
📄 Files processed: ${result.filesProcessed}
🔍 Chunks indexed: ${result.chunksIndexed}

The codebase is now searchable using the search_code tool.`
        }
      ]
    };
  }

  /**
   * Handles project listing requests
   * Returns all indexed projects with basic statistics
   * @param {Object} args - Empty arguments object
   * @returns {Promise<Object>} Formatted project list
   */
  async handleListProjects(args) {
    const projects = await vectorStore.getProjects();
    
    if (projects.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No projects found. Use the index_codebase tool to create your first index.'
          }
        ]
      };
    }

    // Format project list with statistics
    const formatted = projects.map(project => {
      return `**${project.projectId}**
- Documents: ${project.documentCount}
- Last Modified: ${new Date(project.lastModified).toLocaleString()}`;
    }).join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `📚 **Indexed Projects** (${projects.length}):\n\n${formatted}`
        }
      ]
    };
  }

  /**
   * Handles project deletion requests
   * Removes all documents and metadata for the specified project
   * @param {Object} args - Deletion arguments
   * @param {string} args.projectId - Project ID to delete
   * @returns {Promise<Object>} Deletion confirmation
   */
  async handleDeleteProject(args) {
    const { projectId } = args;
    
    const deletedCount = await vectorStore.deleteProject(projectId);
    
    return {
      content: [
        {
          type: 'text',
          text: `🗑️ Deleted project "${projectId}" (${deletedCount} documents removed)`
        }
      ]
    };
  }

  /**
   * Handles project statistics requests
   * Returns detailed information about a project's indexed content
   * @param {Object} args - Statistics arguments
   * @param {string} args.projectId - Project ID to get stats for
   * @returns {Promise<Object>} Formatted project statistics
   */
  async handleGetProjectStats(args) {
    const { projectId } = args;
    
    const stats = await vectorStore.getProjectStats(projectId);
    
    const formatted = `📊 **Project Statistics: ${stats.projectId}**

- Total Documents: ${stats.totalDocuments}
- Total Files: ${stats.totalFiles}

**Files:**
${stats.files.map(file => `- ${file}`).join('\n')}`;

    return {
      content: [
        {
          type: 'text',
          text: formatted
        }
      ]
    };
  }

  /**
   * Handles project update requests with delta indexing
   * Only processes files that have changed since the last indexing
   * @param {Object} args - Update arguments
   * @param {string} args.projectId - Project ID to update
   * @param {string} args.directoryPath - Directory to scan for changes
   * @param {string[]} [args.excludePatterns] - Additional exclude patterns
   * @returns {Promise<Object>} Update results with delta statistics
   */
   async handleUpdateProject(args) {
    const { 
      projectId = DEFAULT_PROJECT_ID, 
      directoryPath = DEFAULT_DIRECTORY_PATH, 
      excludePatterns = [] 
    } = args;

    if (!projectId) {
      throw new Error('Project ID is required (provide as argument or set DEFAULT_PROJECT_ID environment variable)');
    }

    if (!directoryPath) {
      throw new Error('Directory path is required (provide as argument or set DEFAULT_DIRECTORY_PATH environment variable)');
    }

    console.error(`Updating project: ${projectId} from ${directoryPath} (delta only)`);
    
    // Perform delta-only indexing (only changed files)
    const result = await fileIndexer.indexDirectory(directoryPath, projectId, excludePatterns, true);
    
    // Format delta statistics if available
    let statsText = '';
    if (result.deltaStats) {
      statsText = `

📈 **Delta Statistics:**
- Files skipped (unchanged): ${result.deltaStats.skipped}
- Files updated: ${result.deltaStats.updated}
- Files added: ${result.deltaStats.added}
- Files deleted: ${result.deltaStats.deleted}
- Total files scanned: ${result.deltaStats.total}`;
    }
    
    return {
      content: [
        {
          type: 'text',
          text: `🔄 **Successfully updated project "${projectId}"**
📁 Directory: ${directoryPath}
📄 Files processed: ${result.filesProcessed}
🔍 Chunks indexed: ${result.chunksIndexed}${statsText}

The project index has been updated with only the changed files.`
        }
      ]
    };
  }

  /**
   * Starts the MCP server with stdio transport
   * Establishes connection for MCP client communication
   * @returns {Promise<void>}
   */
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Vector MCP Server running on stdio');
  }
}

/**
 * Main application entry point
 * Initializes services and starts the MCP server
 * @returns {Promise<void>}
 */
async function main() {
  await initMCP();
  const server = new VectorMCPServer();
  await server.run();
}

// Start the server
main().catch(console.error);