#!/usr/bin/env node

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

const mongoUri = process.env.MONGODB_URI || 'mongodb://root:examplepassword@localhost:27017';
const mongoClient = new MongoClient(mongoUri);

let vectorStore;
let embeddingProvider;
let fileIndexer;

async function initMCP() {
  try {
    await mongoClient.connect();
    const db = mongoClient.db('code_context');
    const collection = db.collection('documents');

    // Create indexes
    await collection.createIndex({ embedding: 1 });
    await collection.createIndex({ projectId: 1 });
    await collection.createIndex({ filePath: 1 });

    vectorStore = new MongoVectorStore(collection, db);
    embeddingProvider = new OllamaEmbedding(process.env.OLLAMA_MODEL || 'llama2');
    fileIndexer = new FileIndexer(embeddingProvider, vectorStore);
    
    console.error('✅ MCP Vector server initialized');
  } catch (error) {
    console.error('❌ MCP initialization failed:', error);
    throw error;
  }
}

class VectorMCPServer {
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

  setupHandlers() {
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
                  description: 'Project ID to search within (optional)'
                },
                topK: {
                  type: 'number',
                  description: 'Number of results to return (default: 5)',
                  default: 5
                }
              },
              required: ['query']
            }
          },
          {
            name: 'index_codebase',
            description: 'Index a codebase directory for semantic search',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: {
                  type: 'string',
                  description: 'Unique identifier for this project'
                },
                directoryPath: {
                  type: 'string',
                  description: 'Path to the directory to index'
                },
                excludePatterns: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Additional patterns to exclude (beyond defaults)',
                  default: []
                }
              },
              required: ['projectId', 'directoryPath']
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
                  description: 'Project ID to update'
                },
                directoryPath: {
                  type: 'string',
                  description: 'Path to the directory to scan for changes'
                },
                excludePatterns: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Additional patterns to exclude (beyond defaults)',
                  default: []
                }
              },
              required: ['projectId', 'directoryPath']
            }
          }
        ]
      };
    });

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

  async handleSearchCode(args) {
    const { query, projectId, topK = 5 } = args;
    
    if (!query) {
      throw new Error('Query is required');
    }

    console.error(`Searching for: "${query}" in project: ${projectId || 'all'}`);
    
    const queryEmbedding = await embeddingProvider.getEmbedding(query);
    const results = await vectorStore.search(queryEmbedding, topK, projectId);

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

  async handleIndexCodebase(args) {
    const { projectId, directoryPath, excludePatterns = [] } = args;

    console.error(`Indexing codebase: ${projectId} from ${directoryPath}`);
    
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

  async handleUpdateProject(args) {
    const { projectId, directoryPath, excludePatterns = [] } = args;

    console.error(`Updating project: ${projectId} from ${directoryPath} (delta only)`);
    
    const result = await fileIndexer.indexDirectory(directoryPath, projectId, excludePatterns, true);
    
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Vector MCP Server running on stdio');
  }
}

// Initialize and run
async function main() {
  await initMCP();
  const server = new VectorMCPServer();
  await server.run();
}

main().catch(console.error);